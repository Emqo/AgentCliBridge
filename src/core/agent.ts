import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";
import { Config } from "./config.js";
import { Store } from "./store.js";
import { SessionLock } from "./lock.js";
import { AccessControl } from "./permissions.js";
import { EndpointRotator } from "./keys.js";
import type { Endpoint } from "./schema.js";
import { generateSkillDoc } from "../skills/bridge.js";
import { SessionManager, SubSession } from "./session.js";
import { SessionRouter, RouterDecision } from "./router.js";
import { log as rootLog } from "./logger.js";
import { getProvider } from "../providers/registry.js";
import type { Provider } from "../providers/base.js";

const log = rootLog.child("agent");

export interface AgentResponse {
  text: string;
  sessionId: string;
  cost?: number;
  timedOut?: boolean;
  subSessionId?: string;
  label?: string;
}

export type StreamCallback = (chunk: string, full: string) => void | Promise<void>;

export class AgentEngine {
  private lock: SessionLock;
  private rotator: EndpointRotator;
  private sessionMgr: SessionManager;
  private router: SessionRouter;
  private sessionExpiryTimer?: ReturnType<typeof setInterval>;
  access: AccessControl;

  constructor(
    private config: Config,
    private store: Store
  ) {
    this.lock = new SessionLock(
      config.redis.enabled ? config.redis.url : undefined
    );
    this.access = new AccessControl(
      config.access.allowed_users,
      config.access.allowed_groups
    );
    this.rotator = new EndpointRotator(config.endpoints);
    this.sessionMgr = new SessionManager(store, config.agent.session);
    this.router = new SessionRouter(this.sessionMgr, this.rotator, config.agent.session);

    // Periodic idle session expiry (every 5 min)
    this.sessionExpiryTimer = setInterval(() => {
      this.sessionMgr.expireIdle();
    }, 5 * 60 * 1000);
  }

  reloadConfig(config: Config) {
    this.config = config;
    this.access.reload(config.access.allowed_users, config.access.allowed_groups);
    this.rotator.reload(config.endpoints);
    // SessionManager/Router pick up config changes via reference
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

  getSessionManager(): SessionManager {
    return this.sessionMgr;
  }

  getRouter(): SessionRouter {
    return this.router;
  }

  getWorkDir(userId: string): string {
    if (!this.config.workspace.isolation) {
      return this.config.agent.cwd || process.cwd();
    }
    const dir = join(this.config.workspace.base_dir, userId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** @deprecated Use isSessionLocked() for multi-session mode */
  isLocked(userId: string): boolean {
    return this.lock.isLocked(userId);
  }

  isSessionLocked(subSessionId: string): boolean {
    return this.lock.isLocked(subSessionId);
  }

  isMultiSessionEnabled(): boolean {
    return this.config.agent.session?.enabled !== false;
  }

  // ─── Multi-Session Entry Point ───────────────────────────────

  /**
   * Main entry point for user messages in multi-session mode.
   * Routes to the correct sub-session and executes concurrently.
   */
  async handleUserMessage(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    replyToMsgId?: string,
    onChunk?: StreamCallback,
    overrideTimeoutMs?: number
  ): Promise<AgentResponse> {
    // 1. Route
    const decision = await this.router.route(userId, platform, chatId, prompt, replyToMsgId);

    // 2. Create or get sub-session
    let subSession: SubSession;
    if (decision.action === "create") {
      if (!this.sessionMgr.canCreate(userId, platform)) {
        // Evict the oldest idle session to make room
        const active = this.sessionMgr.getActive(userId, platform);
        const oldest = active.sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
        if (oldest) {
          this.sessionMgr.close(oldest.id);
          log.info("evicted oldest sub-session", { sessionId: oldest.id.slice(0, 8), userId });
        }
      }
      subSession = this.sessionMgr.create(userId, platform, chatId, decision.label);
      log.info("created sub-session", { sessionId: subSession.id.slice(0, 8), label: subSession.label, userId });
    } else {
      subSession = this.sessionMgr.get(decision.subSessionId!)!;
      if (!subSession) {
        // Safety fallback: session was closed/deleted between route and get
        subSession = this.sessionMgr.create(userId, platform, chatId, prompt.slice(0, 50));
        log.warn("routed session not found, created new", { sessionId: subSession.id.slice(0, 8), userId });
      }
    }

    // 3. Execute in sub-session (per-session lock)
    const res = await this._executeSubSession(subSession, prompt, platform, chatId, onChunk, overrideTimeoutMs);

    // 4. Post-processing
    this.store.addHistory(userId, platform, "user", prompt);
    this.store.addHistory(userId, platform, "assistant", res.text);
    this.store.recordUsage(userId, platform, res.cost || 0);
    this.sessionMgr.touch(subSession.id);
    this.sessionMgr.addCost(subSession.id, res.cost || 0);

    // 5. Auto-label: set label on first message if empty
    if (subSession.messageCount === 0 && !subSession.label) {
      this.sessionMgr.updateLabel(subSession.id, prompt.slice(0, 50));
      subSession.label = prompt.slice(0, 50);
    }

    // 6. Auto-summarize
    if (this.config.agent.memory?.auto_summary) this._autoSummarize(userId, prompt, res.text);

    return { ...res, subSessionId: subSession.id, label: subSession.label };
  }

  /**
   * Execute a prompt within a specific sub-session.
   * Acquires per-session lock, resumes claude session via -r flag.
   */
  private async _executeSubSession(
    subSession: SubSession,
    prompt: string,
    platform: string,
    chatId: string,
    onChunk?: StreamCallback,
    overrideTimeoutMs?: number
  ): Promise<AgentResponse> {
    const release = await this.lock.acquire(subSession.id);
    try {
      const memories = this.config.agent.memory?.enabled ? this.store.getMemories(subSession.userId) : [];
      const memoryPrompt = memories.length ? memories.map(m => `- ${m.content}`).join("\n") : "";

      const ep = this.rotator.count
        ? this.rotator.next()
        : { name: "default", provider: "claude", model: "" };
      return await this._executeWithSession(subSession, prompt, platform, chatId, ep, onChunk, memoryPrompt, overrideTimeoutMs);
    } finally {
      release();
    }
  }

  /**
   * Core execution: spawn claude CLI with session resume for a sub-session.
   * Thin wrapper around _spawnAgent with sub-session persistence.
   */
  private async _executeWithSession(
    subSession: SubSession,
    prompt: string,
    platform: string,
    chatId: string,
    ep: Endpoint,
    onChunk?: StreamCallback,
    memoryPrompt?: string,
    overrideTimeoutMs?: number
  ): Promise<AgentResponse> {
    try {
      const res = await this._spawnAgent({
        userId: subSession.userId, prompt, platform, chatId, ep, onChunk, memoryPrompt, overrideTimeoutMs,
        resumeSessionId: subSession.claudeSessionId || undefined,
        subSessionId: subSession.id,
        subSessionLabel: subSession.label,
        logLabel: `sub-session=${subSession.id.slice(0, 8)}`,
      });
      if (res.sessionId) this.sessionMgr.setClaudeSessionId(subSession.id, res.sessionId);
      return res;
    } catch (err) {
      this.sessionMgr.setClaudeSessionId(subSession.id, "");
      throw err;
    }
  }

  // ─── Core Spawn Infrastructure ──────────────────────────────

  /** Build the append system prompt (memories + skill doc) */
  private _buildAppendPrompt(opts: {
    userId: string; platform: string; chatId: string;
    memoryPrompt?: string; subSessionId?: string; subSessionLabel?: string;
  }): string {
    let appendPrompt = "";
    if (opts.memoryPrompt) appendPrompt += `User memories:\n${opts.memoryPrompt}\n\n`;
    if (this.config.agent.skill?.enabled !== false) {
      appendPrompt += generateSkillDoc({
        userId: opts.userId, chatId: opts.chatId, platform: opts.platform,
        locale: this.config.locale || "en",
        ...(opts.subSessionId ? { subSessionId: opts.subSessionId, subSessionLabel: opts.subSessionLabel } : {}),
      });
    }
    return appendPrompt.trim();
  }

  /**
   * Unified core: spawn provider CLI, parse stream, handle timeout.
   * All execute methods delegate here.
   */
  private _spawnAgent(opts: {
    userId: string; prompt: string; platform: string; chatId: string;
    ep: Endpoint; onChunk?: StreamCallback; memoryPrompt?: string;
    overrideTimeoutMs?: number; resumeSessionId?: string;
    subSessionId?: string; subSessionLabel?: string;
    logLabel?: string; verbose?: boolean;
  }): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      const provider = getProvider(opts.ep.provider || "claude");
      const cwd = this.getWorkDir(opts.userId);
      const label = opts.logLabel || "";
      const verbose = opts.verbose !== false;

      const appendPrompt = this._buildAppendPrompt(opts);
      const args = provider.buildArgs({
        prompt: opts.prompt,
        model: opts.ep.model,
        resumeSessionId: provider.supportsSessionResume ? opts.resumeSessionId : undefined,
        systemPrompt: this.config.agent.system_prompt || undefined,
        appendSystemPrompt: appendPrompt || undefined,
        allowedTools: this.config.agent.allowed_tools,
        maxTurns: this.config.agent.max_turns,
        maxBudgetUsd: this.config.agent.max_budget_usd,
        permissionMode: this.config.agent.permission_mode || "acceptEdits",
      });
      const env = provider.buildEnv({ CLAUDEBRIDGE_DB: this.store.dbPath });

      const child = spawn(provider.binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end();
      log.info("spawned agent", { provider: opts.ep.provider || "claude", pid: child.pid, label, cwd });

      const timeoutMs = opts.overrideTimeoutMs !== undefined
        ? opts.overrideTimeoutMs
        : (this.config.agent.timeout_seconds || 600) * 1000;
      const timer = timeoutMs > 0 ? setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, timeoutMs) : null;

      let fullText = "";
      let sessionId = opts.resumeSessionId || "";
      let cost = 0;
      let buffer = "";

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (verbose) log.debug("stdout chunk", { data: chunk.slice(0, 200) });
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = provider.parseLine(line);
          switch (event.type) {
            case "session_init":
              if (event.sessionId) sessionId = event.sessionId;
              break;
            case "text_chunk":
              if (event.text) {
                fullText += event.text + "\n";
                if (opts.onChunk) opts.onChunk(event.text, fullText);
              }
              break;
            case "result":
              if (event.text) fullText = event.text;
              if (event.cost) cost = event.cost;
              if (verbose && event.isError) log.error("agent error result", { label });
              break;
          }
        }
      });

      let stderr = "";
      child.stderr.on("data", (data: Buffer) => {
        const s = data.toString();
        stderr += s;
        if (verbose) log.debug("stderr", { data: s.slice(0, 200) });
      });

      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        log.info("agent exited", { code, signal, label, textLen: fullText.length });
        if (signal === "SIGTERM") {
          log.warn("agent timed out", { seconds: timeoutMs / 1000 });
          resolve({ text: fullText.trim() || "(timed out)", sessionId, cost, timedOut: true });
          return;
        }
        if (code === 0 || fullText.trim()) {
          resolve({ text: fullText.trim() || "(no response)", sessionId, cost });
        } else {
          reject(new Error(`agent exited ${code}: ${stderr.slice(0, 500)}`));
        }
      });

      child.on("error", reject);
    });
  }

  // ─── Legacy Single-Session Entry Points ──────────────────────

  /** @deprecated Use handleUserMessage() for multi-session mode */
  async runStream(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    onChunk?: StreamCallback,
    overrideTimeoutMs?: number
  ): Promise<AgentResponse> {
    const release = await this.lock.acquire(userId);
    try {
      this.store.addHistory(userId, platform, "user", prompt);
      const memories = this.config.agent.memory?.enabled ? this.store.getMemories(userId) : [];
      const memoryPrompt = memories.length ? memories.map(m => `- ${m.content}`).join("\n") : "";
      const res = await this._executeWithRetry(userId, prompt, platform, chatId, onChunk, memoryPrompt, overrideTimeoutMs);
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
    onChunk?: StreamCallback,
    overrideTimeoutMs?: number
  ): Promise<AgentResponse> {
    // No per-user lock — parallel tasks are independent
    // No session resume — fresh session to prevent conflicts
    const memories = this.config.agent.memory?.enabled ? this.store.getMemories(userId) : [];
    const memoryPrompt = memories.length ? memories.map(m => `- ${m.content}`).join("\n") : "";
    const ep = this.rotator.count
      ? this.rotator.next()
      : { name: "default", provider: "claude", model: "" };
    const res = await this._executeNoSession(userId, prompt, platform, chatId, ep, onChunk, memoryPrompt, overrideTimeoutMs);
    this.store.recordUsage(userId, platform, res.cost || 0);
    return res;
  }

  private async _executeWithRetry(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    onChunk?: StreamCallback,
    memoryPrompt?: string,
    overrideTimeoutMs?: number
  ): Promise<AgentResponse> {
    const ep = this.rotator.count
      ? this.rotator.next()
      : { name: "default", provider: "claude", model: "" };
    return await this._execute(userId, prompt, platform, chatId, ep, onChunk, memoryPrompt, overrideTimeoutMs);
  }

  /** Legacy single-session execution. Thin wrapper around _spawnAgent with store persistence. */
  private async _execute(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    ep: Endpoint,
    onChunk?: StreamCallback,
    memoryPrompt?: string,
    overrideTimeoutMs?: number
  ): Promise<AgentResponse> {
    const resumeSessionId = this.store.getSession(userId) || undefined;
    try {
      const res = await this._spawnAgent({
        userId, prompt, platform, chatId, ep, onChunk, memoryPrompt, overrideTimeoutMs,
        resumeSessionId, logLabel: `legacy user=${userId}`,
      });
      if (res.sessionId) this.store.setSession(userId, res.sessionId, platform);
      return res;
    } catch (err) {
      this.store.clearSession(userId);
      throw err;
    }
  }

  /** Parallel execution without session resume. Thin wrapper around _spawnAgent. */
  private _executeNoSession(
    userId: string,
    prompt: string,
    platform: string,
    chatId: string,
    ep: Endpoint,
    onChunk?: StreamCallback,
    memoryPrompt?: string,
    overrideTimeoutMs?: number
  ): Promise<AgentResponse> {
    return this._spawnAgent({
      userId, prompt, platform, chatId, ep, onChunk, memoryPrompt, overrideTimeoutMs,
      logLabel: "parallel", verbose: false,
    });
  }

  private _autoSummarize(userId: string, prompt: string, response: string): void {
    const ep = this.rotator.count
      ? this.rotator.next()
      : { name: "default", provider: "claude", model: "" };
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    const summaryPrompt = `Extract 1-3 key facts worth remembering about the user from this exchange. Output only bullet points, no preamble. If nothing worth remembering, output "NONE".\n\nUser: ${prompt.slice(0, 500)}\nAssistant: ${response.slice(0, 1000)}`;
    const args = ["-p", summaryPrompt, "--verbose", "--output-format", "stream-json", "--max-turns", "1", "--max-budget-usd", "0.05"];
    if (ep.model) args.push("--model", ep.model);
    const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    const killTimer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 60000);
    log.info("auto-summary spawned", { pid: child.pid, userId });
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
      clearTimeout(killTimer);
      if (code !== 0) {
        log.warn("auto-summary failed", { code, stderr: stderr.slice(0, 200), userId });
      }
      if (cost > 0) {
        this.store.recordUsage(userId, "auto-summary", cost);
        log.info("auto-summary cost", { cost: cost.toFixed(4), userId });
      }
      if (result && !result.includes("NONE")) {
        const saved = this.store.addMemory(userId, result.trim(), "auto");
        this.store.trimMemories(userId, this.config.agent.memory?.max_memories || 50);
        if (saved) log.info("auto-summary saved", { userId });
        else log.info("auto-summary skipped (duplicate)", { userId });
      } else {
        log.info("auto-summary result=NONE", { userId });
      }
    });
    child.on("error", (err) => { log.warn("auto-summary spawn error", { error: err.message }); });
  }
}
