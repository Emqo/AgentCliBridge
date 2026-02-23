#!/usr/bin/env node

import Database from "better-sqlite3";

const DB_PATH = process.env.CLAUDEBRIDGE_DB;
if (!DB_PATH) {
  console.error("Error: CLAUDEBRIDGE_DB environment variable is required");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const [,, category, action, ...rest] = process.argv;

function output(data: any): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
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
    const r = db.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND user_id = ? AND status = 'pending'").run(parseInt(taskId), userId);
    output({ ok: true, updated: r.changes > 0 });
  } else {
    fail("Usage: task <add|list|done> ...");
  }
} else if (category === "reminder") {
  if (action === "add") {
    const [userId, platform, chatId, minutes, ...descParts] = rest;
    if (!userId || !platform || !chatId || !minutes || !descParts.length) fail("Usage: reminder add <user_id> <platform> <chat_id> <minutes> <description>");
    const remindAt = Date.now() + parseInt(minutes) * 60000;
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
    // Parse optional --parent flag
    let parentId: number | null = null;
    const parentIdx = descParts.indexOf("--parent");
    if (parentIdx !== -1 && descParts[parentIdx + 1]) {
      parentId = parseInt(descParts[parentIdx + 1]);
      descParts.splice(parentIdx, 2);
    }
    const desc = descParts.join(" ");
    const r = db.prepare("INSERT INTO tasks (user_id, platform, chat_id, description, status, parent_id, created_at) VALUES (?, ?, ?, ?, 'auto', ?, ?)").run(userId, platform, chatId, desc, parentId, Date.now());
    output({ ok: true, id: Number(r.lastInsertRowid), message: "Auto task queued" });
  } else if (action === "add-approval") {
    const [userId, platform, chatId, ...descParts] = rest;
    if (!userId || !platform || !chatId || !descParts.length) fail("Usage: auto add-approval <user_id> <platform> <chat_id> <description> [--parent <id>]");
    let parentId: number | null = null;
    const parentIdx = descParts.indexOf("--parent");
    if (parentIdx !== -1 && descParts[parentIdx + 1]) {
      parentId = parseInt(descParts[parentIdx + 1]);
      descParts.splice(parentIdx, 2);
    }
    const desc = descParts.join(" ");
    const r = db.prepare("INSERT INTO tasks (user_id, platform, chat_id, description, status, parent_id, created_at) VALUES (?, ?, ?, ?, 'approval_pending', ?, ?)").run(userId, platform, chatId, desc, parentId, Date.now());
    output({ ok: true, id: Number(r.lastInsertRowid), message: "Auto task queued for approval" });
  } else if (action === "result") {
    const [taskId, ...resultParts] = rest;
    if (!taskId || !resultParts.length) fail("Usage: auto result <task_id> <result_text>");
    const resultText = resultParts.join(" ");
    db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(resultText, parseInt(taskId));
    output({ ok: true, message: "Task result saved" });
  } else if (action === "list") {
    const [userId] = rest;
    if (!userId) fail("Usage: auto list <user_id>");
    const rows = db.prepare("SELECT id, description, status, created_at FROM tasks WHERE user_id = ? AND status IN ('auto','running') ORDER BY created_at DESC").all(userId);
    output({ ok: true, tasks: rows });
  } else if (action === "cancel") {
    const [taskId] = rest;
    if (!taskId) fail("Usage: auto cancel <task_id>");
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(parseInt(taskId));
    output({ ok: true, message: "Auto task cancelled" });
  } else {
    fail("Usage: auto <add|add-approval|result|list|cancel> ...");
  }
} else {
  fail("Usage: claudebridge-ctl <memory|task|reminder|auto> <action> [args...]");
}

db.close();
