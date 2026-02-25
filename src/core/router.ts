import spawn from "cross-spawn";
import { SessionManager, SubSession } from "./session.js";
import { EndpointRotator } from "./keys.js";
import { SessionConfig } from "./config.js";
import { Store } from "./store.js";
import { log as rootLog } from "./logger.js";
import { getProvider } from "../providers/registry.js";

const log = rootLog.child("dispatcher");

export interface RouterDecision {
  action: "route" | "create";
  subSessionId?: string;
  label?: string;
}

export class Dispatcher {
  constructor(
    private sessionMgr: SessionManager,
    private rotator: EndpointRotator,
    private config: SessionConfig,
    private store: Store
  ) {}

  /**
   * Dispatch user message:
   *   Fast path: reply-to → direct route ($0)
   *   Fast path: 0 active → create ($0)
   *   Fast path: 1 active → route ($0)
   *   Classify: 2+ active → Claude classifier with memories + summaries
   */
  async dispatch(
    userId: string,
    platform: string,
    chatId: string,
    messageText: string,
    replyToMsgId?: string
  ): Promise<RouterDecision> {
    // Fast path: reply-to routing
    if (replyToMsgId) {
      const sessId = this.sessionMgr.getSessionByMessage(replyToMsgId, chatId);
      if (sessId) {
        const sess = this.sessionMgr.get(sessId);
        if (sess && this.sessionMgr.isUsable(sess)) {
          return { action: "route", subSessionId: sessId };
        }
      }
    }

    // Fast path: 0-1 active sessions
    const active = this.sessionMgr.getActive(userId, platform);
    if (active.length === 0) {
      return { action: "create", label: messageText.slice(0, 50) };
    }
    if (active.length === 1) {
      return { action: "route", subSessionId: active[0].id };
    }

    // 2+ sessions: classify with memories + summaries
    return await this._classify(userId, platform, messageText, active);
  }

  private async _classify(
    userId: string,
    platform: string,
    text: string,
    sessions: SubSession[]
  ): Promise<RouterDecision> {
    const endTimer = log.time("dispatcher.classify");
    try {
      // Gather context
      const memories = this.store.getMemories(userId);
      const summaries = this.sessionMgr.getSummaries(userId, platform);

      const sessionList = sessions
        .map(s => {
          const ago = Math.round((Date.now() - s.lastActiveAt) / 60000);
          const sum = summaries.find(x => x.id === s.id);
          const summaryText = sum?.summary ? ` | Summary: ${sum.summary}` : "";
          return `[${s.id.slice(0, 8)}] "${s.label || "(no topic)"}" (${ago}min ago${summaryText})`;
        })
        .join("\n");

      const memoryBlock = memories.length
        ? `\nUser context:\n${memories.slice(0, 10).map(m => `- ${m.content}`).join("\n")}\n`
        : "";

      const prompt = `You are a message dispatcher. Route the user's message to the correct conversation, or decide to create a new one, or handle a management request.
${memoryBlock}
Active conversations:
${sessionList}

User message: "${text.slice(0, 300)}"

Reply with ONLY one of:
- An 8-char session ID to route to
- "new" to create a new conversation

No explanation.`;

      const result = await this._callClassifier(prompt);
      const cleaned = result.trim();

      if (cleaned.toLowerCase() === "new") {
        return { action: "create", label: text.slice(0, 50) };
      }

      // Match against active sessions (first 8 chars of ID)
      const match = sessions.find(s => s.id.slice(0, 8) === cleaned.toLowerCase());
      if (match) {
        return { action: "route", subSessionId: match.id };
      }

      // Fallback: route to most recently active
      log.warn("classifier returned unexpected, falling back", { result: cleaned });
      return { action: "route", subSessionId: sessions[0].id };
    } catch (err: any) {
      log.warn("classifier error, creating new session", { error: err.message });
      return { action: "create", label: text.slice(0, 50) };
    } finally {
      endTimer();
    }
  }

  /** Spawn provider CLI for single-turn classification */
  private _callClassifier(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const budget = this.config.dispatcher_budget ?? 0.05;
      const ep = this.rotator.count
        ? this.rotator.next()
        : { name: "default", provider: "claude", model: "" };
      const provider = getProvider(ep.provider || "claude");

      const execOpts = {
        prompt,
        model: this.config.classifier_model || ep.model,
        maxTurns: 1,
        maxBudgetUsd: budget || undefined,
      };
      const args = provider.buildArgs(execOpts);
      const env = provider.buildEnv({});

      const child = spawn(provider.binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      if (provider.promptViaStdin && provider.getStdinPrompt) {
        child.stdin!.write(provider.getStdinPrompt(execOpts));
      }
      child.stdin!.end();

      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 15000);

      let result = "";
      let chunks = "";
      let buffer = "";
      child.stdout!.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = provider.parseLine(line);
          if (event.type === "text_chunk" && event.text) chunks += event.text;
          if (event.type === "result" && event.text) result = event.text;
        }
      });

      let stderr = "";
      child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (!result && chunks) result = chunks.trim();
        if (result) resolve(result);
        else reject(new Error(`classifier exited ${code}: ${stderr.slice(0, 200)}`));
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

// Legacy alias removed — use Dispatcher directly
