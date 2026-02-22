import { loadConfig } from "./core/config.js";
import { SessionManager } from "./core/session.js";
import { AgentEngine } from "./core/agent.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { Adapter } from "./adapters/base.js";

async function main() {
  const config = loadConfig();
  const sessions = new SessionManager();
  const engine = new AgentEngine(config, sessions);

  const adapters: Adapter[] = [];

  if (config.platforms.telegram.enabled) {
    if (!config.platforms.telegram.token) {
      console.error("[fatal] TELEGRAM_BOT_TOKEN not set");
      process.exit(1);
    }
    adapters.push(new TelegramAdapter(engine, sessions, config.platforms.telegram));
  }

  if (config.platforms.discord.enabled) {
    if (!config.platforms.discord.token) {
      console.error("[fatal] DISCORD_BOT_TOKEN not set");
      process.exit(1);
    }
    adapters.push(new DiscordAdapter(engine, sessions, config.platforms.discord));
  }

  if (!adapters.length) {
    console.error("[fatal] no platform enabled");
    process.exit(1);
  }

  for (const a of adapters) await a.start();
  console.log(`[claudebridge] running with ${adapters.length} adapter(s)`);

  const shutdown = () => {
    console.log("[claudebridge] shutting down...");
    for (const a of adapters) a.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
