import { describe, expect, test } from "bun:test";
import { createLimiter, TokenBucket } from "../src/lib/limiter";
import { fakeClock, rejection } from "./helpers";

describe("createLimiter", () => {
  test("never runs more than `concurrency` at once and preserves FIFO order", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) =>
      limit(async () => {
        started.push(i);
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(5);
        active--;
        return i * 10;
      }),
    );
    expect(limit.activeCount).toBe(2);
    expect(limit.pendingCount).toBe(4);
    expect(await Promise.all(tasks)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(maxActive).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(limit.activeCount).toBe(0);
    expect(limit.pendingCount).toBe(0);
  });

  test("a failing task rejects its own promise and frees its slot", async () => {
    const limit = createLimiter(1);
    const failing = limit(() => {
      throw new Error("sync failure");
    });
    const next = limit(async () => "ok");
    expect((await rejection(failing)).message).toBe("sync failure");
    expect(await next).toBe("ok");
  });

  test("rejects a bad concurrency", () => {
    expect(() => createLimiter(0)).toThrow();
    expect(() => createLimiter(1.5)).toThrow();
  });
});

describe("TokenBucket", () => {
  test("allows a burst up to capacity, then refills over time", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, clock });
    expect(bucket.take("ip").ok).toBe(true);
    expect(bucket.take("ip").ok).toBe(true);
    expect(bucket.take("ip").ok).toBe(true);
    const denied = bucket.take("ip");
    expect(denied).toEqual({ ok: false, retryAfterMs: 1000 });
    clock.advance(500);
    expect(bucket.take("ip")).toEqual({ ok: false, retryAfterMs: 500 });
    clock.advance(500);
    expect(bucket.take("ip").ok).toBe(true);
    // Keys are independent.
    expect(bucket.take("other").ok).toBe(true);
    // Refill never exceeds capacity.
    clock.advance(60_000);
    for (let i = 0; i < 3; i++) expect(bucket.take("ip").ok).toBe(true);
    expect(bucket.take("ip").ok).toBe(false);
  });

  test("supports a cost per take", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 2, clock });
    expect(bucket.take("k", 8).ok).toBe(true);
    expect(bucket.take("k", 5)).toEqual({ ok: false, retryAfterMs: 1500 });
  });

  test("evicts idle buckets, but never before they would have refilled", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1, clock, idleEvictMs: 1000 });
    for (let i = 0; i < 5; i++) bucket.take("a");
    bucket.take("b");
    expect(bucket.size).toBe(2);
    // idleEvictMs is raised to the full refill time (5 s).
    clock.advance(4000);
    bucket.sweep();
    expect(bucket.size).toBe(2);
    clock.advance(1000);
    bucket.sweep();
    expect(bucket.size).toBe(0);
    // An evicted key starts again with a full bucket.
    for (let i = 0; i < 5; i++) expect(bucket.take("a").ok).toBe(true);
    // take() also sweeps by itself once per eviction period.
    clock.advance(5000);
    bucket.take("c");
    expect(bucket.size).toBe(1);
  });

  test("caps the number of keys, dropping the least recently used", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.01, clock, maxKeys: 3 });
    for (const key of ["a", "b", "c"]) expect(bucket.take(key).ok).toBe(true);
    expect(bucket.take("a").ok).toBe(false); // touch a: b is now the oldest
    expect(bucket.take("d").ok).toBe(true);
    expect(bucket.size).toBe(3);
    // a and c kept their (empty) buckets; b was dropped.
    expect(bucket.take("a").ok).toBe(false);
    expect(bucket.take("c").ok).toBe(false);
    for (let i = 0; i < 10_000; i++) bucket.take(`k${i}`);
    expect(bucket.size).toBe(3);
  });
});
