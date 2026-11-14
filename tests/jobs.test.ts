import { afterEach, describe, expect, test } from "bun:test";
import { ALERT_AFTER_FAILURES, JobRunner } from "../src/lib/jobs";
import { createMetrics } from "../src/lib/metrics";
import { captureLogger, fakeClock, recordingAlerter } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const runners: JobRunner[] = [];
function makeRunner() {
  const clock = fakeClock();
  const alerter = recordingAlerter();
  const log = captureLogger();
  const metrics = createMetrics();
  const runner = new JobRunner({ log, alerter, clock, metrics });
  runners.push(runner);
  return { runner, clock, alerter, log, metrics };
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.stopAll(100)));
});

describe("JobRunner", () => {
  test("a job's signal aborts as soon as stopAll begins", async () => {
    const { runner } = makeRunner();
    const gate = deferred();
    let seen: AbortSignal | undefined;
    runner.every("batch", 60_000, async (signal) => {
      seen = signal;
      await gate.promise;
    });
    const run = runner.runNow("batch");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    const stopped = runner.stopAll(1_000);
    expect(seen?.aborted).toBe(true);
    gate.resolve();
    await Promise.all([run, stopped]);
  });

  test("overlap guard: a run is skipped while the previous one is in flight", async () => {
    const { runner } = makeRunner();
    const gate = deferred();
    let calls = 0;
    runner.every("slow", 60_000, async () => {
      calls++;
      await gate.promise;
    });
    const first = runner.runNow("slow");
    expect(await runner.runNow("slow")).toBe(false);
    expect(runner.heartbeats()["slow"]).toMatchObject({ running: true, skipped: 1 });
    gate.resolve();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(await runner.runNow("slow")).toBe(true);
    expect(calls).toBe(2);
  });

  test("overlap guard also applies to scheduled ticks", async () => {
    const { runner } = makeRunner();
    const gate = deferred();
    let calls = 0;
    runner.every(
      "ticker",
      10,
      async () => {
        calls++;
        await gate.promise;
      },
      { runOnStart: true },
    );
    runner.start();
    await Bun.sleep(80);
    expect(calls).toBe(1);
    expect(runner.heartbeats()["ticker"]!.skipped).toBeGreaterThan(0);
    gate.resolve();
    await Bun.sleep(40);
    expect(calls).toBeGreaterThan(1);
  });

  test("errors are isolated: a failing job doesn't affect others or its own schedule", async () => {
    const { runner, log, metrics } = makeRunner();
    let okRuns = 0;
    runner.every("bad", 60_000, () => {
      throw new Error("boom");
    });
    runner.every("good", 60_000, () => {
      okRuns++;
    });
    await runner.runNow("bad");
    await runner.runNow("good");
    await runner.runNow("bad");
    expect(okRuns).toBe(1);
    expect(runner.heartbeats()["bad"]).toMatchObject({
      runs: 2,
      failures: 2,
      consecutiveFailures: 2,
      lastError: "boom",
      running: false,
    });
    expect(runner.heartbeats()["good"]).toMatchObject({ runs: 1, failures: 0, lastError: null });
    expect(log.lines.filter((l) => l["msg"] === "job failed")).toHaveLength(2);
    expect(metrics.get("jobs.bad.failures")).toBe(2);
  });

  test(`alerts after ${ALERT_AFTER_FAILURES} consecutive failures; success resets the streak`, async () => {
    const { runner, alerter } = makeRunner();
    let fail = true;
    runner.every("flaky", 60_000, async () => {
      if (fail) throw new Error("upstream down");
    });
    await runner.runNow("flaky");
    await runner.runNow("flaky");
    expect(alerter.alerts).toHaveLength(0);
    await runner.runNow("flaky");
    expect(alerter.alerts).toHaveLength(1);
    expect(alerter.alerts[0]).toMatchObject({ key: "job:flaky" });
    expect(alerter.alerts[0]!.message).toContain("3 times in a row: upstream down");
    fail = false;
    await runner.runNow("flaky");
    expect(runner.heartbeats()["flaky"]).toMatchObject({ consecutiveFailures: 0, lastError: null });
  });

  test("heartbeat records start, end and duration from the clock", async () => {
    const { runner, clock } = makeRunner();
    const start = clock.now();
    runner.every("timed", 60_000, () => {
      clock.advance(1234);
    });
    expect(runner.heartbeats()["timed"]).toMatchObject({ runs: 0, lastStart: null });
    await runner.runNow("timed");
    expect(runner.heartbeats()["timed"]).toEqual({
      lastStart: start,
      lastEnd: start + 1234,
      lastDurationMs: 1234,
      lastError: null,
      runs: 1,
      failures: 0,
      consecutiveFailures: 0,
      skipped: 0,
      running: false,
    });
  });

  test("stopAll stops schedules and waits for in-flight runs", async () => {
    const { runner } = makeRunner();
    const gate = deferred();
    let finished = false;
    let calls = 0;
    runner.every(
      "drain",
      5,
      async () => {
        calls++;
        await gate.promise;
        finished = true;
      },
      { runOnStart: true },
    );
    runner.start();
    await Bun.sleep(20);
    const stopping = runner.stopAll(1000);
    setTimeout(() => gate.resolve(), 20);
    await stopping;
    expect(finished).toBe(true);
    const callsAtStop = calls;
    await Bun.sleep(30);
    expect(calls).toBe(callsAtStop);
  });

  test("rejects duplicate names and bad intervals", () => {
    const { runner } = makeRunner();
    runner.every("x", 1000, () => {});
    expect(() => runner.every("x", 1000, () => {})).toThrow("already registered");
    expect(() => runner.every("y", 0, () => {})).toThrow("positive interval");
  });
});
