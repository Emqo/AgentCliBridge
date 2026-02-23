import { setDefaultAutoSelectFamily } from "net";
setDefaultAutoSelectFamily(false);
import { watch } from "fs";
import { join, dirname, resolve } from "path";
import { loadConfig, reloadConfig } from "./core/config.js";
import { Store } from "./core/store.js";
import { AgentEngine } from "./core/agent.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { WebhookServer } from "./webhook.js";
import { Adapter } from "./adapters/base.js";

async function main() {
  const _cfgIdx = process.argv.indexOf("--config");
  const _cfgPath = _cfgIdx !== -1 ? process.argv[_cfgIdx + 1] : undefined;
  let config = loadConfig(_cfgPath);

  // Derive DB path from config file directory (not CWD)
  const configDir = _cfgPath ? dirname(resolve(_cfgPath)) : process.cwd();
  const dbPath = join(configDir, "data", "claudebridge.db");
  const store = new Store(dbPath);
  const engine = new AgentEngine(config, store);
  const adapters: Adapter[] = [];
  let webhookServer: WebhookServer | null = null;

  if (config.platforms.telegram.enabled) {
    if (!config.platforms.telegram.token) {
      console.error("[fatal] TELEGRAM_BOT_TOKEN not set");
      process.exit(1);
    }
    adapters.push(new TelegramAdapter(engine, store, config.platforms.telegram, config.locale));
  }

  if (config.platforms.discord.enabled) {
    if (!config.platforms.discord.token) {
      console.error("[fatal] DISCORD_BOT_TOKEN not set");
      process.exit(1);
    }
    adapters.push(new DiscordAdapter(engine, store, config.platforms.discord, config.locale));
  }

  if (!adapters.length) {
    console.error("[fatal] no platform enabled");
    process.exit(1);
  }

  // Start webhook server if enabled
  if (config.webhook?.enabled) {
    webhookServer = new WebhookServer(store, config.webhook, config.cron || []);
    webhookServer.start();
  }

  // --- Register signal handlers and hot-reload BEFORE starting adapters ---
  const shutdown = () => {
    console.log("[claudebridge] shutting down...");
    for (const a of adapters) a.stop();
    if (webhookServer) webhookServer.stop();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", () => {
    try {
      config = reloadConfig();
      engine.reloadConfig(config);
      console.log("[claudebridge] config reloaded (SIGHUP)");
    } catch (err) {
      console.error("[claudebridge] config reload failed:", err);
    }
  });

  // Hot reload config.yaml on file change
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  watch(_cfgPath || "config.yaml", () => {
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

  // --- Start adapters (fire-and-forget, they run infinite polling loops) ---
  for (const a of adapters) {
    a.start().catch(err => {
      console.error("[fatal] adapter crashed:", err);
      process.exit(1);
    });
  }
  console.log(`[claudebridge] running with ${adapters.length} adapter(s)`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
