import type { Clock } from "./clock";

export interface Limiter {
  <T>(fn: () => Promise<T> | T): Promise<T>;
  readonly activeCount: number;
  readonly pendingCount: number;
}

/** Runs at most `concurrency` functions at once (p-limit style, FIFO). */
export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  const queue: (() => void)[] = [];

  function limit<T>(fn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        limit.activeCount++;
        // Promise.resolve().then also turns a synchronous throw into a rejection.
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            limit.activeCount--;
            next();
          });
      });
      limit.pendingCount = queue.length;
      next();
    });
  }
  limit.activeCount = 0;
  limit.pendingCount = 0;

  function next(): void {
    if (limit.activeCount >= concurrency) return;
    const start = queue.shift();
    limit.pendingCount = queue.length;
    if (start) start();
  }

  return limit;
}

export interface TokenBucketOptions {
  /** Maximum tokens (burst size). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  clock: Clock;
  /**
   * Buckets untouched this long are dropped. Default 10 min, and never less
   * than the time to refill a bucket completely.
   */
  idleEvictMs?: number;
  /**
   * Most keys kept at once (default 10,000). Beyond that the least recently
   * used bucket is dropped, so unique keys can't grow memory without bound.
   */
  maxKeys?: number;
}

export const DEFAULT_MAX_BUCKET_KEYS = 10_000;

export interface TakeResult {
  ok: boolean;
  /** When `ok` is false: how long until enough tokens are available. */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Keyed token buckets (for example per client IP), with idle eviction. */
export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private readonly idleEvictMs: number;
  private readonly maxKeys: number;
  private lastSweep: number;

  constructor(private readonly options: TokenBucketOptions) {
    if (!(options.capacity > 0) || !(options.refillPerSecond > 0)) {
      throw new Error("capacity and refillPerSecond must be positive");
    }
    // Evicting is only lossless once an idle bucket has refilled completely.
    const fullRefillMs = Math.ceil((options.capacity / options.refillPerSecond) * 1000);
    this.idleEvictMs = Math.max(options.idleEvictMs ?? 10 * 60 * 1000, fullRefillMs);
    this.maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_BUCKET_KEYS);
    this.lastSweep = options.clock.now();
  }

  /** Takes `cost` tokens from `key`'s bucket if it has them. */
  take(key: string, cost = 1): TakeResult {
    const now = this.options.clock.now();
    this.maybeSweep(now);
    const { capacity, refillPerSecond } = this.options;
    const existing = this.buckets.get(key);
    const bucket = existing ?? { tokens: capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed / 1000) * refillPerSecond);
    bucket.updatedAt = now;
    // Re-insert so the Map's order is least recently used first.
    if (existing) this.buckets.delete(key);
    else this.evictForNewKey(now);
    this.buckets.set(key, bucket);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true, retryAfterMs: 0 };
    }
    const missing = cost - bucket.tokens;
    return { ok: false, retryAfterMs: Math.ceil((missing / refillPerSecond) * 1000) };
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Drops buckets idle for longer than idleEvictMs. */
  sweep(now = this.options.clock.now()): void {
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= this.idleEvictMs) this.buckets.delete(key);
    }
  }

  private evictForNewKey(now: number): void {
    if (this.buckets.size < this.maxKeys) return;
    this.sweep(now);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < this.maxKeys) break;
      this.buckets.delete(key);
    }
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweep >= this.idleEvictMs) this.sweep(now);
  }
}
