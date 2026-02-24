import Redis from "ioredis";
import { log as rootLog } from "./logger.js";

const log = rootLog.child("lock");

/** Per-session lock with Redis backend, memory fallback.
 *  Renamed from UserLock to SessionLock — key is now subSessionId, not userId.
 *  Multiple sub-sessions for the same user can run concurrently. */
export class SessionLock {
  private memLocks = new Map<string, Promise<void>>();
  private redis: Redis | null = null;
  private prefix = "claudebridge:lock:session:";
  private ttl = 300; // 5 min max lock

  constructor(redisUrl?: string) {
    if (redisUrl) {
      try {
        this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
        this.redis.connect().catch(() => {
          log.warn("Redis unavailable, falling back to memory");
          this.redis = null;
        });
      } catch {
        this.redis = null;
      }
    }
  }

  async acquire(sessionId: string): Promise<() => void> {
    if (this.redis) return this._acquireRedis(sessionId);
    return this._acquireMem(sessionId);
  }

  isLocked(sessionId: string): boolean {
    if (this.redis) return false; // can't sync-check redis, rely on acquire
    return this.memLocks.has(sessionId);
  }

  /** Return which of the given keys are currently locked (memory backend only) */
  isAnyLocked(keys: string[]): string[] {
    return keys.filter(k => this.memLocks.has(k));
  }

  private async _acquireMem(sessionId: string): Promise<() => void> {
    while (this.memLocks.has(sessionId)) {
      await this.memLocks.get(sessionId);
    }
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    this.memLocks.set(sessionId, p);
    return () => {
      this.memLocks.delete(sessionId);
      release();
    };
  }

  private async _acquireRedis(sessionId: string): Promise<() => void> {
    const key = this.prefix + sessionId;
    const maxWait = this.ttl * 1000 + 5000; // TTL + 5s grace
    const start = Date.now();
    while (true) {
      const ok = await this.redis!.set(key, "1", "EX", this.ttl, "NX");
      if (ok) break;
      if (Date.now() - start > maxWait) throw new Error(`Lock timeout for session ${sessionId}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    return async () => {
      await this.redis!.del(key).catch(() => {});
    };
  }
}
