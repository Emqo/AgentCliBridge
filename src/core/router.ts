import { spawn } from "child_process";
import { SessionManager, SubSession } from "./session.js";
import { EndpointRotator } from "./keys.js";
import { SessionConfig } from "./config.js";
import { log as rootLog } from "./logger.js";

const log = rootLog.child("router");

export interface RouterDecision {
  action: "route" | "create";
  subSessionId?: string;   // when action="route"
  label?: string;           // when action="create"
}

export class SessionRouter {
  constructor(
    private sessionMgr: SessionManager,
    private rotator: EndpointRotator,
    private config: SessionConfig
  ) {}

  /**
   * 3-tier routing:
   *   Tier 1: reply-to → direct route ($0)
   *   Tier 2: 0-1 active sessions → bypass ($0)
   *   Tier 3: 2+ active sessions → Claude classifier (~$0.002)
   */
  async route(
    userId: string,
    platform: string,
    chatId: string,
    messageText: string,
    replyToMsgId?: string
  ): Promise<RouterDecision> {
    // Tier 1: reply-to routing
    if (replyToMsgId) {
      const sessId = this.sessionMgr.getSessionByMessage(replyToMsgId, chatId);
      if (sessId) {
        const sess = this.sessionMgr.get(sessId);
        if (sess && this.sessionMgr.isUsable(sess)) {
          return { action: "route", subSessionId: sessId };
        }
      }
      // reply-to pointed to closed/expired session — fall through to Tier 2/3
    }

    // Tier 2: 0-1 active sessions → direct
    const active = this.sessionMgr.getActive(userId, platform);
    if (active.length === 0) {
      return { action: "create", label: messageText.slice(0, 50) };
    }
    if (active.length === 1) {
      return { action: "route", subSessionId: active[0].id };
    }

    // Tier 3: 2+ sessions → Claude classifier
    return await this._classify(userId, platform, messageText, active);
  }

  /** Single-turn Claude call to classify which session a message belongs to */
  private async _classify(
    userId: string,
    platform: string,
    text: string,
    sessions: SubSession[]
  ): Promise<RouterDecision> {
    try {
      const sessionList = sessions
        .map(s => {
          const ago = Math.round((Date.now() - s.lastActiveAt) / 60000);
          return `[${s.id.slice(0, 8)}] "${s.label || "(no topic)"}" (${ago}min ago)`;
        })
        .join("\n");

      const prompt = `You are a message router. Active conversations:\n${sessionList}\n\nUser message: "${text.slice(0, 200)}"\n\nReply with ONLY the 8-char session ID to route to, or "new" for a new conversation. No explanation.`;

      const result = await this._callClassifier(prompt);
      const cleaned = result.trim().toLowerCase();

      if (cleaned === "new") {
        return { action: "create", label: text.slice(0, 50) };
      }

      // Match against active sessions (first 8 chars of ID)
      const match = sessions.find(s => s.id.slice(0, 8) === cleaned);
      if (match) {
        return { action: "route", subSessionId: match.id };
      }

      // Fallback: if classifier returned something unexpected, route to most recently active
      log.warn("classifier returned unexpected, falling back", { result: cleaned });
      return { action: "route", subSessionId: sessions[0].id };
    } catch (err: any) {
      // Classifier failed — fallback: create new session
      log.warn("classifier error, creating new session", { error: err.message });
      return { action: "create", label: text.slice(0, 50) };
    }
  }

  /** Spawn claude CLI for single-turn classification (no tools, no session) */
  private _callClassifier(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["-p", prompt, "--output-format", "stream-json", "--max-turns", "1"];
      if (this.config.classifier_budget) args.push("--max-budget-usd", String(this.config.classifier_budget));
      if (this.config.classifier_model) args.push("--model", this.config.classifier_model);

      const env: Record<string, string> = { ...process.env as Record<string, string> };
      // Use the first available endpoint for the classifier model
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
