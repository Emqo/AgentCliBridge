import { watch } from "fs";
import { loadConfig, reloadConfig } from "./core/config.js";
import { Store } from "./core/store.js";
import { AgentEngine } from "./core/agent.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { Adapter } from "./adapters/base.js";

async function main() {
  let config = loadConfig();
  const store = new Store();
  const engine = new AgentEngine(config, store);
  const adapters: Adapter[] = [];

  if (config.platforms.telegram.enabled) {
    if (!config.platforms.telegram.token) {
      console.error("[fatal] TELEGRAM_BOT_TOKEN not set");
      process.exit(1);
    }
    adapters.push(new TelegramAdapter(engine, store, config.platforms.telegram));
  }

  if (config.platforms.discord.enabled) {
    if (!config.platforms.discord.token) {
      console.error("[fatal] DISCORD_BOT_TOKEN not set");
      process.exit(1);
    }
    adapters.push(new DiscordAdapter(engine, store, config.platforms.discord));
  }

  if (!adapters.length) {
    console.error("[fatal] no platform enabled");
    process.exit(1);
  }

  for (const a of adapters) await a.start();
  console.log(`[claudebridge] running with ${adapters.length} adapter(s)`);

  // Hot reload config.yaml
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  watch("config.yaml", () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        config = reloadConfig();
        engine.reloadConfig(config);
        console.log("[claudebridge] config reloaded");
      } catch (err) {
        console.error("[claudebridge] config reload failed:", err);
      }
    }, 500); // debounce
  });

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
