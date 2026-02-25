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
  console.log("Usage: agent-cli-bridge (or acb) <start|stop|status|reload|init> [--config path] [--foreground|-f]");
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
    if (existing) { console.log(`Already running (PID ${existing})`); process.exit(0); }
    const resolvedCfg = cfgPath || DEFAULT_CFG;
    const childArgs = [ENTRY, "--config", resolvedCfg];
    if (!foreground) {
      ensureDir();
      const { openSync } = await import("fs");
      const logFd = openSync(LOG_FILE, "a");
      const child = spawn("node", childArgs, { detached: true, stdio: ["ignore", logFd, logFd] });
      child.unref();
      writePid(child.pid!);
      console.log(`Started in background (PID ${child.pid}), log: ${LOG_FILE}`);
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
    if (!pid) { console.log("Not running"); process.exit(1); }
    process.kill(pid, "SIGTERM");
    removePid();
    console.log(`Stopped (PID ${pid})`);
    break;
  }
  case "status": {
    const pid = readPid();
    if (pid) { console.log(`Running (PID ${pid})`); process.exit(0); }
    else { console.log("Not running"); process.exit(1); }
    break;
  }
  case "reload": {
    const pid = readPid();
    if (!pid) { console.log("Not running"); process.exit(1); }
    process.kill(pid, "SIGHUP");
    console.log(`Reload signal sent (PID ${pid})`);
    break;
  }
  case "init": {
    ensureDir();
    const target = cfgPath || DEFAULT_CFG;
    if (existsSync(target)) { console.log(`${target} already exists`); process.exit(0); }
    const example = join(__dirname, "..", "config.yaml.example");
    if (!existsSync(example)) { console.error("config.yaml.example not found"); process.exit(1); }
    copyFileSync(example, target);
    console.log(`Created ${target} from template`);
    break;
  }
  default:
    console.log("Usage: agent-cli-bridge (or acb) <start|stop|status|reload|init> [--config path] [--foreground|-f]");
    process.exit(1);
}
