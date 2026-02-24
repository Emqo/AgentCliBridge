export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let globalLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void { globalLevel = level; }
export function getLogLevel(): LogLevel { return globalLevel; }

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(module: string): Logger;
}

function emit(level: LogLevel, module: string, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[globalLevel]) return;
  const entry = { ts: new Date().toISOString(), level, module, msg, pid: process.pid, ...extra };
  const line = JSON.stringify(entry);
  if (level === "warn" || level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function createLogger(module: string): Logger {
  return {
    debug: (msg, extra?) => emit("debug", module, msg, extra),
    info: (msg, extra?) => emit("info", module, msg, extra),
    warn: (msg, extra?) => emit("warn", module, msg, extra),
    error: (msg, extra?) => emit("error", module, msg, extra),
    child: (sub: string) => createLogger(`${module}:${sub}`),
  };
}

export const log = createLogger("bridge");
