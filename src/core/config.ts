import { readFileSync } from "fs";
import { parse } from "yaml";
import "dotenv/config";
import { Endpoint } from "./keys.js";

export interface AgentConfig {
  allowed_tools: string[];
  permission_mode: string;
  max_turns: number;
  max_budget_usd: number;
  system_prompt: string;
  cwd: string;
}

export interface WorkspaceConfig {
  base_dir: string;
  isolation: boolean;
}

export interface AccessConfig {
  allowed_users: string[];
  allowed_groups: string[];
}

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  chunk_size: number;
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  chunk_size: number;
}

export interface RedisConfig {
  enabled: boolean;
  url: string;
}

export interface Config {
  endpoints: Endpoint[];
  agent: AgentConfig;
  workspace: WorkspaceConfig;
  access: AccessConfig;
  redis: RedisConfig;
  platforms: { telegram: TelegramConfig; discord: DiscordConfig };
}

let _configPath = "config.yaml";

export function loadConfig(path?: string): Config {
  if (path) _configPath = path;
  const raw = parse(readFileSync(_configPath, "utf-8")) as any;
  const c: Config = {
    endpoints: raw.endpoints || [],
    agent: raw.agent,
    workspace: raw.workspace,
    access: raw.access || { allowed_users: [], allowed_groups: [] },
    redis: raw.redis || { enabled: false, url: "" },
    platforms: raw.platforms,
  };
  // defaults for each endpoint
  for (const ep of c.endpoints) {
    ep.name = ep.name || "default";
    ep.base_url = ep.base_url || "";
    ep.api_key = ep.api_key || "";
    ep.model = ep.model || "";
  }
  // env fallback: single endpoint from env vars
  if (!c.endpoints.length && process.env.ANTHROPIC_API_KEY) {
    c.endpoints.push({
      name: "env-default",
      base_url: process.env.ANTHROPIC_BASE_URL || "",
      api_key: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || "",
    });
  }
  c.redis.url = c.redis.url || process.env.REDIS_URL || "";
  c.platforms.telegram.token =
    c.platforms.telegram.token || process.env.TELEGRAM_BOT_TOKEN || "";
  c.platforms.discord = c.platforms.discord || { enabled: false, token: "", chunk_size: 1900 };
  c.platforms.discord.token =
    c.platforms.discord.token || process.env.DISCORD_BOT_TOKEN || "";
  return c;
}

export function reloadConfig(): Config {
  return loadConfig();
}
