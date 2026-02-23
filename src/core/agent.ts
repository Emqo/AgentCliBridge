import { spawn, ChildProcess } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";
import { Config } from "./config.js";
import { Store } from "./store.js";
import { UserLock } from "./lock.js";
import { AccessControl } from "./permissions.js";
import { EndpointRotator, Endpoint } from "./keys.js";
import { generateSkillDoc } from "../skills/bridge.js";

export interface AgentResponse {
  text: string;
  sessionId: string;
  cost?: number;
}

export type StreamCallback = (chunk: string, full: string) => void | Promise<void>;

export class AgentEngine {
  private lock: UserLock;
  private rotator: EndpointRotator;
  access: AccessControl;

  constructor(
    private config: Config,
    private store: Store
  ) {
    this.lock = new UserLock(
      config.redis.enabled ? config.redis.url : undefined
    );
    this.access = new AccessControl(
      config.access.allowed_users,
      config.access.allowed_groups
    );
    this.rotator = new EndpointRotator(config.endpoints);
  }

  reloadConfig(config: Config) {
    this.config = config;
    this.access.reload(config.access.allowed_users, config.access.allowed_groups);
    this.rotator.reload(config.endpoints);
  }

  getEndpoints(): { name: string; model: string }[] {
    return this.rotator.list();
  }

  getRotator(): EndpointRotator {
    return this.rotator;
  }

  getEndpointCount(): number {
    return this.rotator.count;
  }

  getMaxParallel(): number {
    return this.config.agent.max_parallel || 1;
  }

  getWorkDir(userId: string): string {
    if (!this.config.workspace.isolation) {
      return this.config.agent.cwd || process.cwd();
    }
    const dir = join(this.config.workspace.base_dir, userId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  isLocked(userId: string): boolean {
    return this.lock.isLocked(userId);
  }

  async runStream(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    onChunk?: StreamCallback
  ): Promise<AgentResponse> {
    const release = await this.lock.acquire(userId);
    try {
      this.store.addHistory(userId, platform, "user", prompt);
      const memories = this.config.agent.memory?.enabled ? this.store.getMemories(userId) : [];
      const memoryPrompt = memories.length ? memories.map(m => `- ${m.content}`).join("\n") : "";
      const res = await this._executeWithRetry(userId, prompt, platform, chatId, onChunk, memoryPrompt);
      this.store.addHistory(userId, platform, "assistant", res.text);
      this.store.recordUsage(userId, platform, res.cost || 0);
      if (this.config.agent.memory?.auto_summary) this._autoSummarize(userId, prompt, res.text);
      return res;
    } finally {
      release();
    }
  }

  async runParallel(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    onChunk?: StreamCallback
  ): Promise<AgentResponse> {
    // No per-user lock — parallel tasks are independent
    // No session resume — fresh session to prevent conflicts
    const memories = this.config.agent.memory?.enabled ? this.store.getMemories(userId) : [];
    const memoryPrompt = memories.length ? memories.map(m => `- ${m.content}`).join("\n") : "";
    const maxRetries = Math.max(Math.min(this.rotator.count, 3), 1);
    let lastErr: any;
    for (let i = 0; i < maxRetries; i++) {
      const ep = this.rotator.count
        ? this.rotator.next()
        : { name: "cli-default", api_key: "", base_url: "", model: "" };
      try {
        const res = await this._executeNoSession(userId, prompt, platform, chatId, ep, onChunk, memoryPrompt);
        this.store.recordUsage(userId, platform, res.cost || 0);
        return res;
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message || "");
        if (msg.includes("429") || msg.includes("401") || msg.includes("529")) {
          console.warn(`[agent] endpoint ${ep.name} failed (parallel), rotating`);
          this.rotator.markFailed(ep);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private async _executeWithRetry(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    onChunk?: StreamCallback,
    memoryPrompt?: string
  ): Promise<AgentResponse> {
    const maxRetries = Math.max(Math.min(this.rotator.count, 3), 1);
    let lastErr: any;
    for (let i = 0; i < maxRetries; i++) {
      const ep = this.rotator.count
        ? this.rotator.next()
        : { name: "cli-default", api_key: "", base_url: "", model: "" };
      try {
        return await this._execute(userId, prompt, platform, chatId, ep, onChunk, memoryPrompt);
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message || "");
        if (msg.includes("429") || msg.includes("401") || msg.includes("529")) {
          console.warn(`[agent] endpoint ${ep.name} failed, rotating`);
          this.rotator.markFailed(ep);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private _execute(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    ep: Endpoint,
    onChunk?: StreamCallback,
    memoryPrompt?: string
  ): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      const sessionId = this.store.getSession(userId) || "";
      const cwd = this.getWorkDir(userId);

      const args = ["-p", prompt, "--verbose", "--output-format", "stream-json", "--permission-mode", this.config.agent.permission_mode || "acceptEdits"];
      if (ep.model) args.push("--model", ep.model);
      if (sessionId) args.push("-r", sessionId);
      if (this.config.agent.system_prompt) args.push("--system-prompt", this.config.agent.system_prompt);

      // Build combined append prompt: memories + skill doc
      let appendPrompt = "";
      if (memoryPrompt) appendPrompt += `User memories:\n${memoryPrompt}\n\n`;
      if (this.config.agent.skill?.enabled !== false) {
        appendPrompt += generateSkillDoc({ userId, chatId, platform, locale: this.config.locale || "en" });
      }
      if (appendPrompt) args.push("--append-system-prompt", appendPrompt.trim());

      if (this.config.agent.allowed_tools?.length) args.push("--allowed-tools", this.config.agent.allowed_tools.join(","));
      if (this.config.agent.max_turns) args.push("--max-turns", String(this.config.agent.max_turns));
      if (this.config.agent.max_budget_usd) args.push("--max-budget-usd", String(this.config.agent.max_budget_usd));

      const env: Record<string, string> = { ...process.env as Record<string, string> };
      if (ep.api_key) env.ANTHROPIC_API_KEY = ep.api_key;
      if (ep.base_url) env.ANTHROPIC_BASE_URL = ep.base_url;
      env.CLAUDEBRIDGE_DB = this.store.dbPath;

      const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end();
      console.log(`[agent] spawned claude pid=${child.pid} cwd=${cwd} args=${args.join(" ")}`);

      const timeoutMs = (this.config.agent.timeout_seconds || 300) * 1000;
      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, timeoutMs);

      let fullText = "";
      let newSessionId = sessionId;
      let cost = 0;
      let buffer = "";

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        console.log(`[agent] stdout chunk: ${chunk.slice(0, 200)}`);
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
              newSessionId = msg.session_id;
            }
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  fullText += block.text + "\n";
                  if (onChunk) onChunk(block.text, fullText);
                }
              }
            }
            if (msg.type === "result") {
              if (msg.result) fullText = msg.result;
              if (msg.total_cost_usd) cost = msg.total_cost_usd;
              if (msg.is_error) {
                console.error(`[agent] claude error result: subtype=${msg.subtype} message=${JSON.stringify(msg.error_message || msg.message || "unknown").slice(0, 500)}`);
              }
            }
          } catch {}
        }
      });

      let stderr = "";
      child.stderr.on("data", (data: Buffer) => {
        const s = data.toString();
        stderr += s;
        console.log(`[agent] stderr: ${s.slice(0, 200)}`);
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        console.log(`[agent] claude exited code=${code} signal=${signal} fullText=${fullText.length}chars stderr=${stderr.slice(0, 200)}`);
        if (signal === "SIGTERM") {
          if (newSessionId) this.store.setSession(userId, newSessionId, platform);
          resolve({ text: fullText.trim() || "(timed out)", sessionId: newSessionId, cost });
          return;
        }
        if (code === 0 || fullText.trim()) {
          if (newSessionId) this.store.setSession(userId, newSessionId, platform);
          resolve({ text: fullText.trim() || "(no response)", sessionId: newSessionId, cost });
        } else {
          // Don't save session on failure — stale session would lock the user in a failure loop
          this.store.clearSession(userId);
          reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        }
      });

      child.on("error", reject);
    });
  }

  private _executeNoSession(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    ep: Endpoint,
    onChunk?: StreamCallback,
    memoryPrompt?: string
  ): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      const cwd = this.getWorkDir(userId);

      const args = ["-p", prompt, "--verbose", "--output-format", "stream-json", "--permission-mode", this.config.agent.permission_mode || "acceptEdits"];
      if (ep.model) args.push("--model", ep.model);
      // No session resume — fresh session for parallel execution
      if (this.config.agent.system_prompt) args.push("--system-prompt", this.config.agent.system_prompt);

      let appendPrompt = "";
      if (memoryPrompt) appendPrompt += `User memories:\n${memoryPrompt}\n\n`;
      if (this.config.agent.skill?.enabled !== false) {
        appendPrompt += generateSkillDoc({ userId, chatId, platform, locale: this.config.locale || "en" });
      }
      if (appendPrompt) args.push("--append-system-prompt", appendPrompt.trim());

      if (this.config.agent.allowed_tools?.length) args.push("--allowed-tools", this.config.agent.allowed_tools.join(","));
      if (this.config.agent.max_turns) args.push("--max-turns", String(this.config.agent.max_turns));
      if (this.config.agent.max_budget_usd) args.push("--max-budget-usd", String(this.config.agent.max_budget_usd));

      const env: Record<string, string> = { ...process.env as Record<string, string> };
      if (ep.api_key) env.ANTHROPIC_API_KEY = ep.api_key;
      if (ep.base_url) env.ANTHROPIC_BASE_URL = ep.base_url;
      env.CLAUDEBRIDGE_DB = this.store.dbPath;

      const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end();
      console.log(`[agent] spawned claude (parallel) pid=${child.pid} cwd=${cwd}`);

      const timeoutMs = (this.config.agent.timeout_seconds || 300) * 1000;
      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, timeoutMs);

      let fullText = "";
      let sessionId = "";
      let cost = 0;
      let buffer = "";

      child.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
              sessionId = msg.session_id;
            }
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  fullText += block.text + "\n";
                  if (onChunk) onChunk(block.text, fullText);
                }
              }
            }
            if (msg.type === "result") {
              if (msg.result) fullText = msg.result;
              if (msg.total_cost_usd) cost = msg.total_cost_usd;
            }
          } catch {}
        }
      });

      let stderr = "";
      child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        console.log(`[agent] claude (parallel) exited code=${code} signal=${signal} text=${fullText.length}chars`);
        if (code === 0 || fullText.trim() || signal === "SIGTERM") {
          resolve({ text: fullText.trim() || (signal === "SIGTERM" ? "(timed out)" : "(no response)"), sessionId, cost });
        } else {
          reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        }
      });

      child.on("error", reject);
    });
  }

  private _autoSummarize(userId: string, prompt: string, response: string): void {
    const ep = this.rotator.count
      ? this.rotator.next()
      : { name: "cli-default", api_key: "", base_url: "", model: "" };
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (ep.api_key) env.ANTHROPIC_API_KEY = ep.api_key;
    if (ep.base_url) env.ANTHROPIC_BASE_URL = ep.base_url;
    const summaryPrompt = `Extract 1-3 key facts worth remembering about the user from this exchange. Output only bullet points, no preamble. If nothing worth remembering, output "NONE".\n\nUser: ${prompt.slice(0, 500)}\nAssistant: ${response.slice(0, 1000)}`;
    const args = ["-p", summaryPrompt, "--verbose", "--output-format", "stream-json", "--max-turns", "1", "--max-budget-usd", "0.05"];
    if (ep.model) args.push("--model", ep.model);
    const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    console.log(`[agent] auto-summary spawned pid=${child.pid} for ${userId}`);
    let result = "";
    let cost = 0;
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "result") {
            if (msg.result) result = msg.result;
            if (msg.total_cost_usd) cost = msg.total_cost_usd;
          }
        } catch {}
      }
    });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`[agent] auto-summary failed code=${code} stderr=${stderr.slice(0, 200)} for ${userId}`);
      }
      if (cost > 0) {
        this.store.recordUsage(userId, "auto-summary", cost);
        console.log(`[agent] auto-summary cost=$${cost.toFixed(4)} for ${userId}`);
      }
      if (result && !result.includes("NONE")) {
        const saved = this.store.addMemory(userId, result.trim(), "auto");
        this.store.trimMemories(userId, this.config.agent.memory?.max_memories || 50);
        if (saved) console.log(`[agent] auto-summary saved for ${userId}`);
        else console.log(`[agent] auto-summary skipped (duplicate) for ${userId}`);
      } else {
        console.log(`[agent] auto-summary result=NONE for ${userId}`);
      }
    });
    child.on("error", (err) => { console.warn(`[agent] auto-summary spawn error: ${err.message}`); });
  }
}