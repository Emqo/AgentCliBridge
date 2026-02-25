#!/usr/bin/env node
import { spawn } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const DIR = join(homedir(), ".agent-cli-bridge");
const PID_FILE = join(DIR, "agent-cli-bridge.pid");
const LOG_FILE = join(DIR, "agent-cli-bridge.log");
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = join(__dirname, "index.js");

// ─── ANSI helpers ───
const c = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,   // green
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,   // red
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,   // yellow
  c: (s: string) => `\x1b[36m${s}\x1b[0m`,   // cyan
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,    // dim
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,    // bold
};

function ensureDir() { mkdirSync(DIR, { recursive: true }); }

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

function writePid(pid: number) { ensureDir(); writeFileSync(PID_FILE, String(pid)); }

function removePid() { try { unlinkSync(PID_FILE); } catch {} }

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
${c.b("AgentCliBridge")} ${c.d("— CLI AI Agent ↔ Chat Platform Bridge")}

${c.y("Usage:")} acb ${c.c("<command>")} [options]

${c.y("Commands:")}
  ${c.c("start")}    Start the bridge ${c.d("(background by default)")}
  ${c.c("stop")}     Stop the running bridge
  ${c.c("status")}   Check if bridge is running
  ${c.c("reload")}   Hot-reload config ${c.d("(SIGHUP)")}
  ${c.c("init")}     Create config from template

${c.y("Options:")}
  ${c.c("--config")} <path>   Config file path
  ${c.c("-f, --foreground")}  Run in foreground
  ${c.c("-h, --help")}        Show this help
`);
  process.exit(0);
}
const cmd = args.find(a => !a.startsWith("-")) || "start";
const cfgIdx = args.indexOf("--config");
const cfgPath = cfgIdx !== -1 ? args[cfgIdx + 1] : undefined;
const daemon = args.includes("--daemon") || args.includes("-d");
const foreground = args.includes("--foreground") || args.includes("-f");
const DEFAULT_CFG = join(DIR, "config.yaml");

switch (cmd) {
  case "start": {
    const existing = readPid();
    if (existing) { console.log(`${c.y("●")} Already running ${c.d(`(PID ${existing})`)}`); process.exit(0); }
    const resolvedCfg = cfgPath || DEFAULT_CFG;
    const childArgs = [ENTRY, "--config", resolvedCfg];
    if (!foreground) {
      ensureDir();
      const { openSync } = await import("fs");
      const logFd = openSync(LOG_FILE, "a");
      const child = spawn("node", childArgs, { detached: true, stdio: ["ignore", logFd, logFd] });
      child.unref();
      writePid(child.pid!);
      console.log(`${c.g("✔")} Started ${c.d(`(PID ${child.pid})`)}\n  ${c.d("Config:")} ${resolvedCfg}\n  ${c.d("Log:")}    ${LOG_FILE}`);
    } else {
      const child = spawn("node", childArgs, { stdio: "inherit" });
      writePid(child.pid!);
      child.on("exit", (code) => { removePid(); process.exit(code ?? 0); });
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
    }
    break;
  }
  case "stop": {
    const pid = readPid();
    if (!pid) { console.log(`${c.r("✖")} Not running`); process.exit(1); }
    process.kill(pid, "SIGTERM");
    removePid();
    console.log(`${c.g("✔")} Stopped ${c.d(`(PID ${pid})`)}`);
    break;
  }
  case "status": {
    const pid = readPid();
    if (pid) { console.log(`${c.g("●")} Running ${c.d(`(PID ${pid})`)}`); process.exit(0); }
    else { console.log(`${c.r("●")} Not running`); process.exit(1); }
    break;
  }
  case "reload": {
    const pid = readPid();
    if (!pid) { console.log(`${c.r("✖")} Not running`); process.exit(1); }
    process.kill(pid, "SIGHUP");
    console.log(`${c.g("✔")} Reload signal sent ${c.d(`(PID ${pid})`)}`);
    break;
  }
  case "init": {
    ensureDir();
    const target = cfgPath || DEFAULT_CFG;
    if (existsSync(target)) { console.log(`${c.y("●")} ${target} already exists`); process.exit(0); }
    const example = join(__dirname, "..", "config.yaml.example");
    if (!existsSync(example)) { console.error(`${c.r("✖")} config.yaml.example not found`); process.exit(1); }
    copyFileSync(example, target);
    console.log(`${c.g("✔")} Created ${c.c(target)}`);
    break;
  }
  default:
    console.log(`${c.r("✖")} Unknown command: ${cmd}\n  Run ${c.c("acb --help")} for usage`);
    process.exit(1);
}
