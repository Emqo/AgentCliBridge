import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = "./data/sessions.db";

export class SessionManager {
  private db: Database.Database;

  constructor() {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        user_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  get(userId: string): string | null {
    const row = this.db
      .prepare("SELECT session_id FROM sessions WHERE user_id = ?")
      .get(userId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  set(userId: string, sessionId: string, platform: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (user_id, session_id, platform, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET session_id=?, updated_at=?`
      )
      .run(userId, sessionId, platform, Date.now(), sessionId, Date.now());
  }

  clear(userId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}
