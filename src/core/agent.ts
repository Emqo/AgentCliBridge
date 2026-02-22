import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "fs";
import { join } from "path";
import { Config } from "./config.js";
import { SessionManager } from "./session.js";
import { UserLock } from "./lock.js";
import { PermissionManager } from "./permissions.js";

export interface AgentResponse {
  text: string;
  sessionId: string;
  cost?: number;
}

export type StreamCallback = (chunk: string, full: string) => void | Promise<void>;

export class AgentEngine {
  private lock: UserLock;
  private perms: PermissionManager;

  constructor(
    private config: Config,
    private sessions: SessionManager
  ) {
    this.lock = new UserLock(
      config.redis.enabled ? config.redis.url : undefined
    );
    this.perms = new PermissionManager(
      config.permissions.users,
      config.permissions.default_role,
      config.permissions.custom_roles
    );
  }

  private getWorkDir(userId: string): string {
    if (!this.config.workspace.isolation) {
      return this.config.agent.cwd || process.cwd();
    }
    const dir = join(this.config.workspace.base_dir, userId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (this.config.api.api_key) env.ANTHROPIC_API_KEY = this.config.api.api_key;
    if (this.config.api.base_url) env.ANTHROPIC_BASE_URL = this.config.api.base_url;
    return env;
  }

  private buildOpts(userId: string) {
    const existingSession = this.sessions.get(userId);
    const ac = this.config.agent;
    const roleConfig = this.perms.getRoleConfig(userId);

    const opts: Record<string, unknown> = {
      allowedTools: roleConfig.allowed_tools,
      permissionMode: ac.permission_mode,
      maxTurns: roleConfig.max_turns,
      maxBudgetUsd: roleConfig.max_budget_usd,
      cwd: this.getWorkDir(userId),
      env: this.buildEnv(),
    };
    if (this.config.api.model) opts.model = this.config.api.model;
    if (ac.system_prompt) opts.systemPrompt = ac.system_prompt;
    if (existingSession) opts.resume = existingSession;
    return { opts, existingSession };
  }

  getUserRole(userId: string) {
    return this.perms.getRole(userId);
  }

  isLocked(userId: string): boolean {
    return this.lock.isLocked(userId);
  }

  async run(userId: string, prompt: string, platform: string): Promise<AgentResponse> {
    const release = await this.lock.acquire(userId);
    try {
      return await this._execute(userId, prompt, platform);
    } finally {
      release();
    }
  }

  async runStream(
    userId: string,
    prompt: string,
    platform: string,
    onChunk: StreamCallback
  ): Promise<AgentResponse> {
    const release = await this.lock.acquire(userId);
    try {
      return await this._execute(userId, prompt, platform, onChunk);
    } finally {
      release();
    }
  }

  private async _execute(
    userId: string,
    prompt: string,
    platform: string,
    onChunk?: StreamCallback
  ): Promise<AgentResponse> {
    const { opts, existingSession } = this.buildOpts(userId);
    let sessionId = existingSession || "";
    let fullText = "";
    let cost = 0;

    for await (const message of query({ prompt, options: opts as any })) {
      const msg = message as any;

      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        sessionId = msg.session_id;
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if ("text" in block) {
            fullText += block.text + "\n";
            if (onChunk) await onChunk(block.text, fullText);
          }
        }
      }

      if (msg.type === "result") {
        if (msg.result) fullText = msg.result;
        if (msg.total_cost_usd) cost = msg.total_cost_usd;
      }
    }

    if (sessionId) this.sessions.set(userId, sessionId, platform);
    return { text: fullText.trim() || "(no response)", sessionId, cost };
  }
}