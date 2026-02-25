import { setDefaultAutoSelectFamily } from "net";
setDefaultAutoSelectFamily(false);
import { watch, existsSync } from "fs";
import { join, dirname, resolve } from "path";

// Windows: auto-detect git-bash for Claude CLI
if (process.platform === "win32" && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
  try {
    const { execSync } = await import("child_process");
    const gitPath = execSync("where git.exe", { encoding: "utf-8" }).trim().split("\n")[0].trim();
    if (gitPath) {
      // Walk up from git.exe to find Git root (contains bin/bash.exe)
      let dir = dirname(gitPath);
      for (let i = 0; i < 4; i++) {
        const candidate = join(dir, "bin", "bash.exe");
        if (existsSync(candidate)) { process.env.CLAUDE_CODE_GIT_BASH_PATH = candidate; break; }
        dir = dirname(dir);
      }
    }
  } catch {}
}
import { loadConfig, reloadConfig } from "./core/config.js";
import { Store } from "./core/store.js";
import { AgentEngine } from "./core/agent.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { WebhookServer } from "./webhook.js";
import { Adapter } from "./adapters/base.js";
import { log, setLogLevel, LogLevel, initFileLog, closeFileLog } from "./core/logger.js";

async function main() {
  const _cfgIdx = process.argv.indexOf("--config");
  const _cfgPath = _cfgIdx !== -1 ? process.argv[_cfgIdx + 1] : undefined;
  let config = loadConfig(_cfgPath);
  const configDir = _cfgPath ? dirname(resolve(_cfgPath)) : process.cwd();
  const logLevel = (config.log?.level || config.log_level || "info") as LogLevel;
  setLogLevel(logLevel);
  if (config.log?.file?.enabled) {
    const logDir = resolve(configDir, config.log.file.dir || "./logs");
    initFileLog(logDir, config.log.file);
  }

  // Derive DB path from config file directory (not CWD)
  const dbPath = join(configDir, "data", "agent-cli-bridge.db");
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
  const shutdown = (exitCode?: number) => {
    log.info("shutting down...");
    closeFileLog();
    if (exitCode !== undefined) process.exitCode = exitCode;
    engine.killAll();
    for (const a of adapters) a.stop();
    if (webhookServer) webhookServer.stop();
    store.close();
    setTimeout(() => process.exit(process.exitCode ?? 0), 1000);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: err.message, stack: err.stack });
    shutdown(1);
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error("unhandled rejection", { error: msg });
  });
  const doReload = (source: string) => {
    try {
      config = reloadConfig();
      engine.reloadConfig(config);
      setLogLevel((config.log?.level || config.log_level || "info") as LogLevel);
      for (const a of adapters) {
        if ('reloadConfig' in a && typeof a.reloadConfig === 'function') {
          const plat = a.constructor.name === 'TelegramAdapter' ? config.platforms.telegram : config.platforms.discord;
          a.reloadConfig(plat, config.locale);
        }
      }
      log.info("config reloaded", { source });
    } catch (err: any) {
      log.error("config reload failed", { error: err?.message });
    }
  };

  process.on("SIGHUP", () => doReload("SIGHUP"));

  // Hot reload config.yaml on file change
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  watch(_cfgPath || "config.yaml", () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => doReload("file-watch"), 500);
  });

  // --- Start adapters with crash recovery ---
  for (const a of adapters) {
    const startWithRetry = async (attempt = 0) => {
      try {
        await a.start();
      } catch (err: any) {
        if (attempt >= 2) {
          log.error("adapter restart failed after 3 attempts, exiting", { adapter: a.constructor.name, error: err?.message });
          process.exit(1);
        }
        const delay = Math.min(5000 * Math.pow(2, attempt), 60000);
        log.error("adapter crashed, retrying", { adapter: a.constructor.name, attempt: attempt + 1, retryIn: delay / 1000, error: err?.message });
        setTimeout(() => startWithRetry(attempt + 1), delay);
      }
    };
    startWithRetry();
  }
  log.info("running", { adapters: adapters.length });
}

main().catch((err) => {
  log.error("fatal", { error: err?.message });
  process.exit(1);
});
