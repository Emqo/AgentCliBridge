import Redis from "ioredis";

/** Per-user lock with Redis backend, memory fallback */
export class UserLock {
  private memLocks = new Map<string, Promise<void>>();
  private redis: Redis | null = null;
  private prefix = "claudebridge:lock:";
  private ttl = 300; // 5 min max lock

  constructor(redisUrl?: string) {
    if (redisUrl) {
      try {
        this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
        this.redis.connect().catch(() => {
          console.warn("[lock] Redis unavailable, falling back to memory");
          this.redis = null;
        });
      } catch {
        this.redis = null;
      }
    }
  }

  async acquire(userId: string): Promise<() => void> {
    if (this.redis) return this._acquireRedis(userId);
    return this._acquireMem(userId);
  }

  isLocked(userId: string): boolean {
    if (this.redis) return false; // can't sync-check redis, rely on acquire
    return this.memLocks.has(userId);
  }

  private async _acquireMem(userId: string): Promise<() => void> {
    while (this.memLocks.has(userId)) {
      await this.memLocks.get(userId);
    }
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    this.memLocks.set(userId, p);
    return () => {
      this.memLocks.delete(userId);
      release();
    };
  }

  private async _acquireRedis(userId: string): Promise<() => void> {
    const key = this.prefix + userId;
    // spin until acquired
    while (true) {
      const ok = await this.redis!.set(key, "1", "EX", this.ttl, "NX");
      if (ok) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return async () => {
      await this.redis!.del(key).catch(() => {});
    };
  }
}
