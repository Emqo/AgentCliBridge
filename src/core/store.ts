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
}