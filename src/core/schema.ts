import { z } from "zod";

const EndpointSchema = z.object({
  name: z.string().default("default"),
  model: z.string().default(""),
  provider: z.string().default("claude"),
});

const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  auto_summary: z.boolean().default(true),
  max_memories: z.number().int().positive().default(50),
});

const SkillConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

const SessionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_per_user: z.number().int().positive().default(3),
  idle_timeout_minutes: z.number().positive().default(30),
  dispatcher_budget: z.number().nonnegative().default(0.05),
  classifier_model: z.string().default(""),
});

const AgentConfigSchema = z.object({
  allowed_tools: z.array(z.string()).default([]),
  permission_mode: z.string().default("acceptEdits"),
  max_turns: z.number().int().positive().default(50),
  max_budget_usd: z.number().nonnegative().default(2.0),
  system_prompt: z.string().default(""),
  cwd: z.string().default(""),
  timeout_seconds: z.number().int().nonnegative().default(0),
  max_parallel: z.number().int().positive().default(1),
  memory: MemoryConfigSchema.default(() => ({}) as any),
  skill: SkillConfigSchema.default(() => ({}) as any),
  session: SessionConfigSchema.default(() => ({}) as any),
});

const WorkspaceConfigSchema = z.object({
  base_dir: z.string().default("./workspaces"),
  isolation: z.boolean().default(true),
});

const AccessConfigSchema = z.object({
  allowed_users: z.array(z.string()).default([]),
  allowed_groups: z.array(z.string()).default([]),
});

const TelegramConfigSchema = z.object({
  enabled: z.boolean().default(true),
  token: z.string().default(""),
  chunk_size: z.number().int().positive().default(4000),
});

const DiscordConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(""),
  chunk_size: z.number().int().positive().default(1900),
});

const RedisConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(""),
});

const WebhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().positive().default(3100),
  token: z.string().default(""),
  github_secret: z.string().default(""),
});

const CronEntrySchema = z.object({
  schedule_minutes: z.number().int().positive(),
  user_id: z.string(),
  platform: z.string(),
  chat_id: z.string(),
  description: z.string(),
});

const PlatformsSchema = z.object({
  telegram: TelegramConfigSchema.default(() => ({}) as any),
  discord: DiscordConfigSchema.default(() => ({}) as any),
});

export const ConfigSchema = z.object({
  endpoints: z.array(EndpointSchema).default([]),
  log_level: z.string().default("info"),
  locale: z.string().default("en"),
  agent: AgentConfigSchema.default(() => ({}) as any),
  workspace: WorkspaceConfigSchema.default(() => ({}) as any),
  access: AccessConfigSchema.default(() => ({}) as any),
  redis: RedisConfigSchema.default(() => ({}) as any),
  platforms: PlatformsSchema.default(() => ({}) as any),
  webhook: WebhookConfigSchema.default(() => ({}) as any),
  cron: z.array(CronEntrySchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type SkillConfig = z.infer<typeof SkillConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type AccessConfig = z.infer<typeof AccessConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;
export type RedisConfig = z.infer<typeof RedisConfigSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type CronEntry = z.infer<typeof CronEntrySchema>;
