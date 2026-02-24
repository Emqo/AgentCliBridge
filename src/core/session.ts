import { randomUUID } from "crypto";
import { Store } from "./store.js";
import { SessionConfig } from "./config.js";
import { log as rootLog } from "./logger.js";

const log = rootLog.child("session");

export interface SubSession {
  id: string;
  userId: string;
  platform: string;
  chatId: string;
  claudeSessionId: string | null;
  label: string;
  summary: string;
  status: "active" | "idle" | "expired" | "closed";
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  totalCost: number;
}

/** Maps a DB row to a SubSession domain object */
function toSubSession(row: any): SubSession {
  return {
    id: row.id,
    userId: row.user_id,
    platform: row.platform,
    chatId: row.chat_id,
    claudeSessionId: row.claude_session_id ?? null,
    label: row.label,
    summary: row.summary ?? "",
    status: row.status,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    messageCount: row.message_count,
    totalCost: row.total_cost,
  };
}

export class SessionManager {
  constructor(
    private store: Store,
    private config: SessionConfig
  ) {}

  /** Create a new sub-session for the user */
  create(userId: string, platform: string, chatId: string, label?: string): SubSession {
    const id = randomUUID();
    const trimmedLabel = (label || "").slice(0, 50);
    this.store.createSubSession(id, userId, platform, chatId, trimmedLabel);
    const row = this.store.getSubSession(id);
    return toSubSession(row!);
  }

  /** Get a sub-session by ID */
  get(sessionId: string): SubSession | null {
    const row = this.store.getSubSession(sessionId);
    return row ? toSubSession(row) : null;
  }

  /** Get all active (active/idle) sub-sessions for a user+platform */
  getActive(userId: string, platform: string): SubSession[] {
    return this.store.getActiveSubSessions(userId, platform).map(toSubSession);
  }

  /** Update lastActiveAt and increment message count */
  touch(sessionId: string): void {
    this.store.touchSubSession(sessionId);
  }

  /** Save the claude CLI session_id for resume */
  setClaudeSessionId(sessionId: string, claudeId: string): void {
    this.store.setSubSessionClaudeId(sessionId, claudeId);
  }

  /** Update the topic label */
  updateLabel(sessionId: string, label: string): void {
    this.store.updateSubSessionLabel(sessionId, label.slice(0, 50));
  }

  /** Add cost to a sub-session */
  addCost(sessionId: string, cost: number): void {
    if (cost > 0) this.store.updateSubSessionCost(sessionId, cost);
  }

  /** Close a specific sub-session */
  close(sessionId: string): void {
    this.store.closeSubSession(sessionId);
  }

  /** Close all active sub-sessions for a user (equivalent to /new) */
  closeAll(userId: string): void {
    this.store.closeAllSubSessions(userId);
  }

  /** Check if a user can create another sub-session (within limit) */
  canCreate(userId: string, platform: string): boolean {
    const active = this.store.getActiveSubSessions(userId, platform);
    return active.length < this.config.max_per_user;
  }

  /** Expire idle sub-sessions and prune old message mappings. Call periodically. */
  expireIdle(): number {
    const timeoutMs = this.config.idle_timeout_minutes * 60 * 1000;
    const expired = this.store.expireIdleSessions(timeoutMs);
    // Also prune message mappings older than 24h
    this.store.pruneSubSessionMessages(24 * 60 * 60 * 1000);
    if (expired > 0) log.info("expired idle sub-sessions", { count: expired });
    return expired;
  }

  /** Track a platform message → sub-session mapping (for reply-to routing) */
  trackMessage(platformMsgId: string, chatId: string, subSessionId: string): void {
    this.store.trackSubSessionMessage(platformMsgId, chatId, subSessionId);
  }

  /** Look up which sub-session a platform message belongs to */
  getSessionByMessage(platformMsgId: string, chatId: string): string | null {
    return this.store.getSubSessionByMessage(platformMsgId, chatId);
  }

  /** Check if a sub-session is usable (active or idle) */
  isUsable(session: SubSession): boolean {
    return session.status === "active" || session.status === "idle";
  }

  /** Get all sub-sessions for a user (all statuses) */
  getAll(userId: string): SubSession[] {
    return this.store.getAllSubSessions(userId).map(toSubSession);
  }

  /** Update the summary of a sub-session */
  updateSummary(sessionId: string, summary: string): void {
    this.store.updateSubSessionSummary(sessionId, summary);
  }

  /** Get summaries of active sub-sessions for dispatcher context */
  getSummaries(userId: string, platform: string): { id: string; label: string; summary: string; lastActiveAt: number }[] {
    return this.store.getSubSessionSummaries(userId, platform).map(r => ({
      id: r.id, label: r.label, summary: r.summary, lastActiveAt: r.last_active_at,
    }));
  }
}
