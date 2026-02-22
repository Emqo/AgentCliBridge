import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "fs";
import { join } from "path";
import { Config } from "./config.js";
import { Store } from "./store.js";
import { UserLock } from "./lock.js";
import { AccessControl } from "./permissions.js";
import { EndpointRotator, Endpoint } from "./keys.js";

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

  getEndpointCount(): number {
    return this.rotator.count;
  }

  private getWorkDir(userId: string): string {
    if (!this.config.workspace.isolation) {
      return this.config.agent.cwd || process.cwd();
    }
    const dir = join(this.config.workspace.base_dir, userId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private buildEnv(ep: Endpoint): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    env.ANTHROPIC_API_KEY = ep.api_key;
    if (ep.base_url) env.ANTHROPIC_BASE_URL = ep.base_url;
    return env;
  }

  private buildOpts(userId: string, ep: Endpoint) {
    const existingSession = this.store.getSession(userId);
    const ac = this.config.agent;
    const opts: Record<string, unknown> = {
      allowedTools: ac.allowed_tools,
      permissionMode: ac.permission_mode,
      maxTurns: ac.max_turns,
      maxBudgetUsd: ac.max_budget_usd,
      cwd: this.getWorkDir(userId),
      env: this.buildEnv(ep),
    };
    if (ep.model) opts.model = ep.model;
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
      const res = await this._executeWithRetry(userId, prompt, platform, onChunk);
      this.store.addHistory(userId, platform, "assistant", res.text);
      this.store.recordUsage(userId, platform, res.cost || 0);
      return res;
    } finally {
      release();
    }
  }

  private async _executeWithRetry(
    userId: string,
    prompt: string,
    platform: string,
    onChunk?: StreamCallback
  ): Promise<AgentResponse> {
    const maxRetries = Math.min(this.rotator.count, 3);
    let lastErr: any;
    for (let i = 0; i < maxRetries; i++) {
      const ep = this.rotator.next();
      try {
        return await this._execute(userId, prompt, platform, ep, onChunk);
      } catch (err: any) {
        lastErr = err;
        const status = err?.status || err?.statusCode;
        if (status === 429 || status === 401 || status === 529) {
          console.warn(`[agent] endpoint ${ep.name} failed (${status}), rotating`);
          this.rotator.markFailed(ep);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private async _execute(
    userId: string,
    prompt: string,
    platform: string,
    ep: Endpoint,
    onChunk?: StreamCallback
  ): Promise<AgentResponse> {
    const { opts, existingSession } = this.buildOpts(userId, ep);
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