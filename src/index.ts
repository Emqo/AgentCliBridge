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
import { log, setLogLevel, LogLevel } from "./core/logger.js";

async function main() {
  const _cfgIdx = process.argv.indexOf("--config");
  const _cfgPath = _cfgIdx !== -1 ? process.argv[_cfgIdx + 1] : undefined;
  let config = loadConfig(_cfgPath);
  if (config.log_level) setLogLevel(config.log_level as LogLevel);

  // Derive DB path from config file directory (not CWD)
  const configDir = _cfgPath ? dirname(resolve(_cfgPath)) : process.cwd();
  const dbPath = join(configDir, "data", "claudebridge.db");
  const store = new Store(dbPath);
  const engine = new AgentEngine(config, store);
  const adapters: Adapter[] = [];
  let webhookServer: WebhookServer | null = null;

  if (config.platforms.telegram.enabled) {
    if (!config.platforms.telegram.token) {
      log.error("TELEGRAM_BOT_TOKEN not set");
      process.exit(1);
    }
    adapters.push(new TelegramAdapter(engine, store, config.platforms.telegram, config.locale));
  }

  if (config.platforms.discord.enabled) {
    if (!config.platforms.discord.token) {
      log.error("DISCORD_BOT_TOKEN not set");
      process.exit(1);
    }
    adapters.push(new DiscordAdapter(engine, store, config.platforms.discord, config.locale));
  }

  if (!adapters.length) {
    log.error("no platform enabled");
    process.exit(1);
  }

  // Start webhook server if enabled
  if (config.webhook?.enabled) {
    webhookServer = new WebhookServer(store, config.webhook, config.cron || []);
    webhookServer.start();
  }

  // --- Register signal handlers and hot-reload BEFORE starting adapters ---
  const shutdown = () => {
    log.info("shutting down...");
    for (const a of adapters) a.stop();
    if (webhookServer) webhookServer.stop();
    store.close();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: err.message, stack: err.stack });
    shutdown();
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error("unhandled rejection", { error: msg });
  });
  process.on("SIGHUP", () => {
    try {
      config = reloadConfig();
      engine.reloadConfig(config);
      for (const a of adapters) {
        if ('reloadConfig' in a && typeof a.reloadConfig === 'function') {
          const plat = a.constructor.name === 'TelegramAdapter' ? config.platforms.telegram : config.platforms.discord;
          a.reloadConfig(plat, config.locale);
        }
      }
      log.info("config reloaded (SIGHUP)");
    } catch (err: any) {
      log.error("config reload failed", { error: err?.message });
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
        for (const a of adapters) {
          if ('reloadConfig' in a && typeof a.reloadConfig === 'function') {
            const plat = a.constructor.name === 'TelegramAdapter' ? config.platforms.telegram : config.platforms.discord;
            a.reloadConfig(plat, config.locale);
          }
        }
        log.info("config reloaded");
      } catch (err: any) {
        log.error("config reload failed", { error: err?.message });
      }
    }, 500); // debounce
  });

  // --- Start adapters with crash recovery ---
  for (const a of adapters) {
    a.start().catch(err => {
      log.error("adapter crashed, retry in 10s", { adapter: a.constructor.name, error: err?.message });
      setTimeout(() => {
        a.start().catch(err2 => {
          log.error("adapter restart failed, exiting", { error: err2?.message });
          process.exit(1);
        });
      }, 10000);
    });
  }
  log.info("running", { adapters: adapters.length });
}

main().catch((err) => {
  log.error("fatal", { error: err?.message });
  process.exit(1);
});
