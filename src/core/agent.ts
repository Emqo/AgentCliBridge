import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "fs";
import { join } from "path";
import { Config } from "./config.js";
import { Store } from "./store.js";
import { UserLock } from "./lock.js";
import { AccessControl } from "./permissions.js";

export interface AgentResponse {
  text: string;
  sessionId: string;
  cost?: number;
}

export type StreamCallback = (chunk: string, full: string) => void | Promise<void>;

export class AgentEngine {
  private lock: UserLock;
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
  }

  reloadConfig(config: Config) {
    this.config = config;
    this.access.reload(config.access.allowed_users, config.access.allowed_groups);
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
    const existingSession = this.store.getSession(userId);
    const ac = this.config.agent;
    const opts: Record<string, unknown> = {
      allowedTools: ac.allowed_tools,
      permissionMode: ac.permission_mode,
      maxTurns: ac.max_turns,
      maxBudgetUsd: ac.max_budget_usd,
      cwd: this.getWorkDir(userId),
      env: this.buildEnv(),
    };
    if (this.config.api.model) opts.model = this.config.api.model;
    if (ac.system_prompt) opts.systemPrompt = ac.system_prompt;
    if (existingSession) opts.resume = existingSession;
    return { opts, existingSession };
  }

  isLocked(userId: string): boolean {
    return this.lock.isLocked(userId);
  }

  async runStream(
    userId: string,
    prompt: string,
    platform: string,
    onChunk?: StreamCallback
  ): Promise<AgentResponse> {
    const release = await this.lock.acquire(userId);
    try {
      this.store.addHistory(userId, platform, "user", prompt);
      const res = await this._execute(userId, prompt, platform, onChunk);
      this.store.addHistory(userId, platform, "assistant", res.text);
      this.store.recordUsage(userId, platform, res.cost || 0);
      return res;
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

    if (sessionId) this.store.setSession(userId, sessionId, platform);
    return { text: fullText.trim() || "(no response)", sessionId, cost };
  }
}