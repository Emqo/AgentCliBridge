import { readFileSync } from "fs";
import { parse } from "yaml";
import "dotenv/config";

export interface ApiConfig {
  base_url: string;
  api_key: string;
  model: string;
}

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
  api: ApiConfig;
  agent: AgentConfig;
  workspace: WorkspaceConfig;
  access: AccessConfig;
  redis: RedisConfig;
  platforms: { telegram: TelegramConfig; discord: DiscordConfig };
}

let _configPath = "config.yaml";

export function loadConfig(path?: string): Config {
  if (path) _configPath = path;
  const raw = parse(readFileSync(_configPath, "utf-8"));
  const c = raw as Config;
  c.api.api_key = c.api.api_key || process.env.ANTHROPIC_API_KEY || "";
  c.api.base_url = c.api.base_url || process.env.ANTHROPIC_BASE_URL || "";
  c.api.model = c.api.model || process.env.ANTHROPIC_MODEL || "";
  c.access = c.access || { allowed_users: [], allowed_groups: [] };
  c.redis = c.redis || { enabled: false, url: "" };
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
