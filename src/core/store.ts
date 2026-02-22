import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = "./data/claudebridge.db";

export class Store {
  private db: Database.Database;

  constructor() {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        user_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id);
      CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, created_at);
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        remind_at INTEGER,
        reminder_sent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, status);
    `);
  }

  // --- sessions ---
  getSession(userId: string): string | null {
    const row = this.db
      .prepare("SELECT session_id FROM sessions WHERE user_id = ?")
      .get(userId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  setSession(userId: string, sessionId: string, platform: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (user_id, session_id, platform, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET session_id=?, updated_at=?`
      )
      .run(userId, sessionId, platform, Date.now(), sessionId, Date.now());
  }

  clearSession(userId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  // --- usage ---
  recordUsage(userId: string, platform: string, costUsd: number): void {
    this.db
      .prepare("INSERT INTO usage (user_id, platform, cost_usd, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, platform, costUsd, Date.now());
  }

  getUsage(userId: string): { total_cost: number; count: number } {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd),0) as total_cost, COUNT(*) as count FROM usage WHERE user_id = ?")
      .get(userId) as { total_cost: number; count: number };
    return row;
  }

  getUsageAll(): { user_id: string; total_cost: number; count: number }[] {
    return this.db
      .prepare("SELECT user_id, COALESCE(SUM(cost_usd),0) as total_cost, COUNT(*) as count FROM usage GROUP BY user_id ORDER BY total_cost DESC")
      .all() as any[];
  }

  // --- history ---
  addHistory(userId: string, platform: string, role: string, content: string): void {
    this.db
      .prepare("INSERT INTO history (user_id, platform, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, platform, role, content, Date.now());
  }

  getHistory(userId: string, limit = 10): { role: string; content: string; created_at: number }[] {
    return this.db
      .prepare("SELECT role, content, created_at FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit) as any[];
  }

  // --- memories ---
  addMemory(userId: string, content: string, source = "manual"): boolean {
    // Dedup: skip if identical content already exists for this user
    const existing = this.db.prepare(
      "SELECT id FROM memories WHERE user_id = ? AND content = ? LIMIT 1"
    ).get(userId, content);
    if (existing) return false;
    this.db.prepare("INSERT INTO memories (user_id, content, source, created_at) VALUES (?, ?, ?, ?)").run(userId, content, source, Date.now());
    return true;
  }

  getMemories(userId: string): { id: number; content: string; source: string; created_at: number }[] {
    return this.db.prepare("SELECT id, content, source, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC").all(userId) as any[];
  }

  clearMemories(userId: string): void {
    this.db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
  }

  trimMemories(userId: string, max: number): void {
    this.db.prepare("DELETE FROM memories WHERE user_id = ? AND id NOT IN (SELECT id FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)").run(userId, userId, max);
  }

  // --- tasks ---
  addTask(userId: string, platform: string, chatId: string, description: string, remindAt?: number, auto = false): number {
    const r = this.db.prepare("INSERT INTO tasks (user_id, platform, chat_id, description, status, remind_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, platform, chatId, description, auto ? "auto" : "pending", remindAt ?? null, Date.now());
    return Number(r.lastInsertRowid);
  }

  getTasks(userId: string): { id: number; description: string; status: string; remind_at: number | null; created_at: number }[] {
    return this.db.prepare("SELECT id, description, status, remind_at, created_at FROM tasks WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC").all(userId) as any[];
  }

  completeTask(taskId: number, userId: string): boolean {
    const r = this.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND user_id = ? AND status = 'pending'").run(taskId, userId);
    return r.changes > 0;
  }

  getDueReminders(): { id: number; user_id: string; platform: string; chat_id: string; description: string }[] {
    return this.db.prepare("SELECT id, user_id, platform, chat_id, description FROM tasks WHERE status = 'pending' AND remind_at IS NOT NULL AND remind_at <= ? AND reminder_sent = 0").all(Date.now()) as any[];
  }

  markReminderSent(taskId: number): void {
    this.db.prepare("UPDATE tasks SET reminder_sent = 1 WHERE id = ?").run(taskId);
  }

  getNextAutoTask(): { id: number; user_id: string; platform: string; chat_id: string; description: string } | null {
    return (this.db.prepare("SELECT id, user_id, platform, chat_id, description FROM tasks WHERE status = 'auto' ORDER BY created_at ASC LIMIT 1").get() as any) ?? null;
  }

  markTaskRunning(taskId: number): void {
    this.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(taskId);
  }

  markTaskResult(taskId: number, status: string): void {
    this.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);
  }

  getAutoTasks(userId: string): { id: number; description: string; status: string; created_at: number }[] {
    return this.db.prepare("SELECT id, description, status, created_at FROM tasks WHERE user_id = ? AND status IN ('auto','running') ORDER BY created_at DESC").all(userId) as any[];
  }
}