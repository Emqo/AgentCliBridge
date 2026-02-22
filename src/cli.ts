#!/usr/bin/env node
import { spawn } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const DIR = join(homedir(), ".claudebridge");
const PID_FILE = join(DIR, "claudebridge.pid");
const LOG_FILE = join(DIR, "claudebridge.log");
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
const cmd = args.find(a => !a.startsWith("-")) || "start";
const cfgIdx = args.indexOf("--config");
const cfgPath = cfgIdx !== -1 ? args[cfgIdx + 1] : undefined;
const daemon = args.includes("--daemon") || args.includes("-d");

switch (cmd) {
  case "start": {
    const existing = readPid();
    if (existing) { console.log(`Already running (PID ${existing})`); process.exit(0); }
    const childArgs = [ENTRY, ...(cfgPath ? ["--config", cfgPath] : [])];
    if (daemon) {
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
    if (existsSync("config.yaml")) { console.log("config.yaml already exists"); process.exit(0); }
    const example = join(__dirname, "..", "config.yaml.example");
    if (!existsSync(example)) { console.error("config.yaml.example not found"); process.exit(1); }
    copyFileSync(example, "config.yaml");
    console.log("Created config.yaml from template");
    break;
  }
  default:
    console.log("Usage: claudebridge <start|stop|status|reload|init> [--config path] [--daemon|-d]");
    process.exit(1);
}
