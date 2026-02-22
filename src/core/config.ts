import { readFileSync } from "fs";
import { parse } from "yaml";
import "dotenv/config";
import { Role, UserRoleEntry, RoleConfig } from "./permissions.js";

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

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  allowed_users: number[];
  chunk_size: number;
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  allowed_users: string[];
  chunk_size: number;
}

export interface PermissionsConfig {
  default_role: Role;
  users: UserRoleEntry[];
  custom_roles: Record<string, RoleConfig>;
}

export interface RedisConfig {
  enabled: boolean;
  url: string;
}

export interface Config {
  api: ApiConfig;
  agent: AgentConfig;
  workspace: WorkspaceConfig;
  permissions: PermissionsConfig;
  redis: RedisConfig;
  platforms: { telegram: TelegramConfig; discord: DiscordConfig };
}

export function loadConfig(path = "config.yaml"): Config {
  const raw = parse(readFileSync(path, "utf-8"));
  const c = raw as Config;
  // env overrides
  c.api.api_key = c.api.api_key || process.env.ANTHROPIC_API_KEY || "";
  c.api.base_url = c.api.base_url || process.env.ANTHROPIC_BASE_URL || "";
  c.api.model = c.api.model || process.env.ANTHROPIC_MODEL || "";
  c.platforms.telegram.token =
    c.platforms.telegram.token || process.env.TELEGRAM_BOT_TOKEN || "";
  c.platforms.discord = c.platforms.discord || { enabled: false, token: "", allowed_users: [], chunk_size: 1900 };
  c.platforms.discord.token =
    c.platforms.discord.token || process.env.DISCORD_BOT_TOKEN || "";
  // defaults
  c.permissions = c.permissions || { default_role: "user", users: [], custom_roles: {} };
  c.redis = c.redis || { enabled: false, url: "" };
  c.redis.url = c.redis.url || process.env.REDIS_URL || "";
  return c;
}
