import { readFileSync } from "fs";
import { parse } from "yaml";
import "dotenv/config";
import { ConfigSchema } from "./schema.js";

export type {
  Config, Endpoint, AgentConfig, MemoryConfig, SkillConfig,
  SessionConfig, WorkspaceConfig, AccessConfig, TelegramConfig,
  DiscordConfig, RedisConfig, WebhookConfig, CronEntry,
} from "./schema.js";

import type { Config } from "./schema.js";

let _configPath = "config.yaml";

export function loadConfig(path?: string): Config {
  if (path) _configPath = path;
  const raw = parse(readFileSync(_configPath, "utf-8")) || {};
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }
  const c = result.data;
  c.redis.url = c.redis.url || process.env.REDIS_URL || "";
  c.platforms.telegram.token = c.platforms.telegram.token || process.env.TELEGRAM_BOT_TOKEN || "";
  c.platforms.discord.token = c.platforms.discord.token || process.env.DISCORD_BOT_TOKEN || "";
  return c;
}

export function reloadConfig(): Config {
  return loadConfig();
}
