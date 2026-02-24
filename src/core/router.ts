import { spawn } from "child_process";
import { SessionManager, SubSession } from "./session.js";
import { EndpointRotator } from "./keys.js";
import { SessionConfig } from "./config.js";
import { Store } from "./store.js";
import { log as rootLog } from "./logger.js";

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

  /** Classify with user memories + sub-session summaries for context */
  private async _classify(
    userId: string,
    platform: string,
    text: string,
    sessions: SubSession[]
  ): Promise<RouterDecision> {
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
    }
  }

  /** Spawn claude CLI for single-turn classification */
  private _callClassifier(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const budget = (this.config as any).dispatcher_budget ?? (this.config as any).classifier_budget ?? 0.05;
      const args = ["-p", prompt, "--output-format", "stream-json", "--max-turns", "1"];
      if (budget) args.push("--max-budget-usd", String(budget));
      if (this.config.classifier_model) args.push("--model", this.config.classifier_model);

      const env: Record<string, string> = { ...process.env as Record<string, string> };
      if (this.rotator.count) {
        const ep = this.rotator.next();
        if (!this.config.classifier_model && ep.model) args.push("--model", ep.model);
      }

      const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end();

      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 15000);

      let result = "";
      let buffer = "";
      child.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "result" && msg.result) result = msg.result;
          } catch {}
        }
      });

      let stderr = "";
      child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
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

// Backward compatibility alias
export { Dispatcher as SessionRouter };
