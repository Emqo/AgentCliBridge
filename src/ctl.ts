#!/usr/bin/env node

import Database from "better-sqlite3";

const DB_PATH = process.env.AGENT_CLI_BRIDGE_DB;
if (!DB_PATH) {
  console.error("Error: AGENT_CLI_BRIDGE_DB environment variable is required");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const [,, category, action, ...rest] = process.argv;

function output(data: any): void {
  if (!process.stdout.isTTY) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  // Pretty output for human terminal usage
  const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const d = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const cc = (s: string) => `\x1b[36m${s}\x1b[0m`;

  if (data.message) console.log(`${data.ok ? g("✔") : r("✖")} ${data.message}`);
  if (data.id && !data.message?.includes("#")) console.log(`  ${d("ID:")} ${cc(String(data.id))}`);
  if (data.scheduled_at) console.log(`  ${d("Scheduled:")} ${new Date(data.scheduled_at).toLocaleString()}`);
  if (data.remind_at) console.log(`  ${d("Remind at:")} ${new Date(data.remind_at).toLocaleString()}`);
  if (data.deleted != null) console.log(`  ${d("Deleted:")} ${data.deleted}`);

  if (data.memories) {
    if (!data.memories.length) { console.log(`${y("●")} No memories`); return; }
    console.log(`${g("●")} ${data.memories.length} memories:`);
    for (const m of data.memories) {
      const ago = Math.round((Date.now() - m.created_at) / 60000);
      console.log(`  ${cc(`#${m.id}`)} ${m.content} ${d(`(${m.source}, ${ago}min ago)`)}`);
    }
  }
  if (data.tasks) {
    if (!data.tasks.length) { console.log(`${y("●")} No tasks`); return; }
    const icon: Record<string, string> = { pending: "○", auto: "◎", running: "◉", done: g("✔"), failed: r("✖") };
    console.log(`${g("●")} ${data.tasks.length} tasks:`);
    for (const t of data.tasks as any[]) {
      const sched = t.scheduled_at ? ` ${d(`[sched: ${new Date(t.scheduled_at).toLocaleString()}]`)}` : "";
      console.log(`  ${icon[t.status] || "?"} ${cc(`#${t.id}`)} [${t.status}] ${t.description.slice(0, 80)}${sched}`);
    }
  }
  if (data.reminders) {
    if (!data.reminders.length) { console.log(`${y("●")} No reminders`); return; }
    console.log(`${g("●")} ${data.reminders.length} reminders:`);
    for (const r2 of data.reminders as any[]) {
      const at = r2.remind_at ? new Date(r2.remind_at).toLocaleString() : "?";
      const sent = r2.reminder_sent ? g(" [sent]") : y(" [pending]");
      console.log(`  ${cc(`#${r2.id}`)} ${r2.description.slice(0, 80)} ${d(`@ ${at}`)}${sent}`);
    }
  }
  if (data.sessions) {
    if (!data.sessions.length) { console.log(`${y("●")} No sessions`); return; }
    const sIcon: Record<string, string> = { active: g("●"), idle: y("●"), expired: r("●"), closed: d("●") };
    console.log(`${g("●")} ${data.sessions.length} sessions:`);
    for (const s of data.sessions as any[]) {
      const ago = Math.round((Date.now() - s.last_active_at) / 60000);
      console.log(`  ${sIcon[s.status] || "?"} ${cc(s.id.slice(0, 8))} "${s.label || "(no topic)"}" ${d(`${ago}min ago, ${s.message_count} msgs, $${s.total_cost.toFixed(4)}`)}`);
    }
  }
  if (data.updated != null && !data.message) {
    console.log(data.updated ? `${g("✔")} Updated` : `${y("●")} No changes`);
  }
}

function fail(msg: string): never {
  if (process.stderr.isTTY) console.error(`\x1b[31m✖\x1b[0m ${msg}`);
  else console.error(msg);
  process.exit(1);
}

function safeInt(val: string, label: string): number {
  const n = parseInt(val, 10);
  if (isNaN(n)) fail(`Invalid ${label}: ${val}`);
  return n;
}

function extractFlag(parts: string[], flag: string): string | null {
  // Search from end to avoid matching flag text inside description
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === flag) {
      const val = parts[i + 1];
      parts.splice(i, 2);
      return val;
    }
  }
  return null;
}

if (category === "memory") {
  if (action === "add") {
    const [userId, ...contentParts] = rest;
    if (!userId || !contentParts.length) fail("Usage: memory add <user_id> <content>");
    const content = contentParts.join(" ");
    const existing = db.prepare("SELECT id FROM memories WHERE user_id = ? AND content = ? LIMIT 1").get(userId, content);
    if (existing) {
      output({ ok: true, message: "Memory already exists", duplicate: true });
    } else {
      const r = db.prepare("INSERT INTO memories (user_id, content, source, created_at) VALUES (?, ?, 'manual', ?)").run(userId, content, Date.now());
      output({ ok: true, id: Number(r.lastInsertRowid), message: "Memory saved" });
    }
  } else if (action === "list") {
    const [userId] = rest;
    if (!userId) fail("Usage: memory list <user_id>");
    const rows = db.prepare("SELECT id, content, source, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC").all(userId);
    output({ ok: true, memories: rows });
  } else if (action === "clear") {
    const [userId] = rest;
    if (!userId) fail("Usage: memory clear <user_id>");
    db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
    output({ ok: true, message: "All memories cleared" });
  } else {
    fail("Usage: memory <add|list|clear> ...");
  }
} else if (category === "task") {
  if (action === "add") {
    const [userId, platform, chatId, ...descParts] = rest;
    if (!userId || !platform || !chatId || !descParts.length) fail("Usage: task add <user_id> <platform> <chat_id> <description>");
    const desc = descParts.join(" ");
    const r = db.prepare("INSERT INTO tasks (user_id, platform, chat_id, description, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(userId, platform, chatId, desc, Date.now());
    output({ ok: true, id: Number(r.lastInsertRowid), message: "Task added" });
  } else if (action === "list") {
    const [userId] = rest;
    if (!userId) fail("Usage: task list <user_id>");
    const rows = db.prepare("SELECT id, description, status, remind_at, created_at FROM tasks WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC").all(userId);
    output({ ok: true, tasks: rows });
  } else if (action === "done") {
    const [taskId, userId] = rest;
    if (!taskId || !userId) fail("Usage: task done <task_id> <user_id>");
    const r = db.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND user_id = ? AND status = 'pending'").run(safeInt(taskId, "task_id"), userId);
    output({ ok: true, updated: r.changes > 0 });
  } else {
    fail("Usage: task <add|list|done> ...");
  }
} else if (category === "reminder") {
  if (action === "add") {
    const [userId, platform, chatId, minutes, ...descParts] = rest;
    if (!userId || !platform || !chatId || !minutes || !descParts.length) fail("Usage: reminder add <user_id> <platform> <chat_id> <minutes> <description>");
    const remindAt = Date.now() + safeInt(minutes, "minutes") * 60000;
    const desc = descParts.join(" ");
    const r = db.prepare("INSERT INTO tasks (user_id, platform, chat_id, description, status, remind_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(userId, platform, chatId, desc, remindAt, Date.now());
    output({ ok: true, id: Number(r.lastInsertRowid), remind_at: remindAt, message: `Reminder set for ${minutes} minutes` });
  } else if (action === "list") {
    const [userId] = rest;
    if (!userId) fail("Usage: reminder list <user_id>");
    const rows = db.prepare("SELECT id, description, remind_at, reminder_sent, created_at FROM tasks WHERE user_id = ? AND remind_at IS NOT NULL ORDER BY created_at DESC").all(userId);
    output({ ok: true, reminders: rows });
  } else {
    fail("Usage: reminder <add|list> ...");
  }
} else if (category === "auto") {
  if (action === "add") {
    const [userId, platform, chatId, ...descParts] = rest;
    if (!userId || !platform || !chatId || !descParts.length) fail("Usage: auto add <user_id> <platform> <chat_id> <description> [--parent <id>]");
    const parentRaw = extractFlag(descParts, "--parent");
    const parentId = parentRaw ? safeInt(parentRaw, "parent_id") : null;
    const delayRaw = extractFlag(descParts, "--delay");
    const scheduledAt = delayRaw ? Date.now() + safeInt(delayRaw, "delay") * 60000 : null;
    const desc = descParts.join(" ");
    // Queue depth check (default max: 50)
    const MAX_QUEUE_DEPTH = 50;
    const pending = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id = ? AND status IN ('auto','running')").get(userId) as { c: number };
    if (pending.c >= MAX_QUEUE_DEPTH) fail(`Queue full: ${pending.c}/${MAX_QUEUE_DEPTH} auto tasks pending/running. Cancel or wait for tasks to complete.`);
    const r = db.prepare("INSERT INTO tasks (user_id, platform, chat_id, description, status, parent_id, scheduled_at, created_at) VALUES (?, ?, ?, ?, 'auto', ?, ?, ?)").run(userId, platform, chatId, desc, parentId, scheduledAt, Date.now());
    output({ ok: true, id: Number(r.lastInsertRowid), scheduled_at: scheduledAt, message: scheduledAt ? `Auto task scheduled (in ${Math.ceil((scheduledAt - Date.now()) / 60000)} min)` : "Auto task queued" });
  } else if (action === "add-approval") {
    const [userId, platform, chatId, ...descParts] = rest;
    if (!userId || !platform || !chatId || !descParts.length) fail("Usage: auto add-approval <user_id> <platform> <chat_id> <description> [--parent <id>] [--delay <minutes>]");
    const parentRaw = extractFlag(descParts, "--parent");
    const parentId = parentRaw ? safeInt(parentRaw, "parent_id") : null;
    const delayRaw = extractFlag(descParts, "--delay");
    const scheduledAt = delayRaw ? Date.now() + safeInt(delayRaw, "delay") * 60000 : null;
    const desc = descParts.join(" ");
    const r = db.prepare("INSERT INTO tasks (user_id, platform, chat_id, description, status, parent_id, scheduled_at, created_at) VALUES (?, ?, ?, ?, 'approval_pending', ?, ?, ?)").run(userId, platform, chatId, desc, parentId, scheduledAt, Date.now());
    output({ ok: true, id: Number(r.lastInsertRowid), scheduled_at: scheduledAt, message: scheduledAt ? `Auto task queued for approval (scheduled in ${Math.ceil((scheduledAt - Date.now()) / 60000)} min)` : "Auto task queued for approval" });
  } else if (action === "result") {
    const [taskId, ...resultParts] = rest;
    if (!taskId || !resultParts.length) fail("Usage: auto result <task_id> <result_text>");
    const resultText = resultParts.join(" ");
    db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(resultText, safeInt(taskId, "task_id"));
    output({ ok: true, message: "Task result saved" });
  } else if (action === "list") {
    const [userId] = rest;
    if (!userId) fail("Usage: auto list <user_id>");
    const rows = db.prepare("SELECT id, description, status, scheduled_at, created_at FROM tasks WHERE user_id = ? AND status IN ('auto','running') ORDER BY created_at DESC").all(userId);
    output({ ok: true, tasks: rows });
  } else if (action === "cancel") {
    const [taskId] = rest;
    if (!taskId) fail("Usage: auto cancel <task_id>");
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(safeInt(taskId, "task_id"));
    output({ ok: true, message: "Auto task cancelled" });
  } else if (action === "clear") {
    const [userId] = rest;
    if (!userId) fail("Usage: auto clear <user_id>");
    const r = db.prepare("DELETE FROM tasks WHERE user_id = ? AND status IN ('done','failed','cancelled')").run(userId);
    output({ ok: true, deleted: r.changes, message: `Cleared ${r.changes} completed/failed/cancelled task(s)` });
  } else {
    fail("Usage: auto <add|add-approval|result|list|cancel|clear> ...");
  }
} else if (category === "file") {
  if (action === "send") {
    const [userId, platform, chatId, filePath, ...captionParts] = rest;
    if (!userId || !platform || !chatId || !filePath) fail("Usage: file send <user_id> <platform> <chat_id> <file_path> [caption...]");
    const { resolve, dirname, join, normalize } = await import("path");
    const { existsSync } = await import("fs");
    const resolved = resolve(filePath);
    // Security: restrict file sends to workspace directory
    const workspaceRoot = resolve(join(dirname(DB_PATH), "..", "workspaces", userId));
    const normalizedResolved = normalize(resolved);
    const normalizedRoot = normalize(workspaceRoot);
    if (!normalizedResolved.startsWith(normalizedRoot)) fail(`Access denied: file must be within workspace directory ${normalizedRoot}`);
    if (!existsSync(resolved)) fail(`File not found: ${resolved}`);
    const caption = captionParts.join(" ");
    const r = db.prepare("INSERT INTO file_sends (user_id, platform, chat_id, file_path, caption, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)").run(userId, platform, chatId, resolved, caption, Date.now());
    output({ ok: true, id: Number(r.lastInsertRowid), message: `File queued for sending: ${resolved}` });
  } else {
    fail("Usage: file <send> ...");
  }
} else if (category === "session") {
  if (action === "list") {
    const [userId] = rest;
    if (!userId) fail("Usage: session list <user_id>");
    const rows = db.prepare("SELECT id, user_id, platform, chat_id, claude_session_id, label, status, created_at, last_active_at, message_count, total_cost FROM sub_sessions WHERE user_id = ? ORDER BY last_active_at DESC").all(userId);
    output({ ok: true, sessions: rows });
  } else {
    fail("Usage: session <list> ...");
  }
} else {
  fail("Usage: agent-cli-bridge-ctl <memory|task|reminder|auto|file|session> <action> [args...]");
}

db.close();
