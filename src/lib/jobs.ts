import { settleWithin } from "./async";
import type { Alerter } from "./alert";
import type { Clock } from "./clock";
import type { Logger } from "./log";
import type { Metrics } from "./metrics";

export interface JobOptions {
  /** Run once as soon as the runner starts (after jitter). */
  runOnStart?: boolean;
  /** Adds a random 0..jitterMs delay to every scheduled run. */
  jitterMs?: number;
}

export interface Heartbeat {
  lastStart: number | null;
  lastEnd: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  /** Ticks skipped because the previous run was still going. */
  skipped: number;
  running: boolean;
}

/**
 * A job body. The signal aborts when stopAll() begins, so a long batch can stop
 * starting new work during shutdown. Functions that ignore it stay assignable.
 */
export type JobFn = (signal: AbortSignal) => Promise<void> | void;

interface Job {
  name: string;
  intervalMs: number;
  fn: JobFn;
  options: JobOptions;
  heartbeat: Heartbeat;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
}

/** Consecutive failures before an alert fires. */
export const ALERT_AFTER_FAILURES = 3;

export interface JobRunnerDeps {
  log: Logger;
  alerter: Alerter;
  clock: Clock;
  metrics?: Metrics;
  /** For tests: replaces Math.random in jitter. */
  random?: () => number;
}

/**
 * Runs periodic jobs. A job never overlaps itself: a tick that comes while
 * the previous run is still going is skipped. A failing job is logged and
 * counted but never stops its schedule or affects other jobs.
 */
export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private started = false;
  private stopped = false;
  private readonly stopController = new AbortController();

  constructor(private readonly deps: JobRunnerDeps) {}

  /** Registers a job. If the runner has already started, it is scheduled right away. */
  every(name: string, intervalMs: number, fn: JobFn, options: JobOptions = {}): void {
    if (this.jobs.has(name)) throw new Error(`job "${name}" is already registered`);
    if (!(intervalMs > 0)) throw new Error(`job "${name}" needs a positive interval`);
    const job: Job = {
      name,
      intervalMs,
      fn,
      options,
      timer: null,
      inFlight: null,
      heartbeat: {
        lastStart: null,
        lastEnd: null,
        lastDurationMs: null,
        lastError: null,
        runs: 0,
        failures: 0,
        consecutiveFailures: 0,
        skipped: 0,
        running: false,
      },
    };
    this.jobs.set(name, job);
    if (this.started && !this.stopped) this.schedule(job, true);
  }

  /** Starts every registered job's schedule. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.jobs.values()) this.schedule(job, true);
  }

  /**
   * Runs a job now, outside its schedule. Returns false without running it
   * when the job is already in flight (the overlap guard).
   */
  async runNow(name: string): Promise<boolean> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`unknown job "${name}"`);
    if (job.inFlight) {
      job.heartbeat.skipped++;
      return false;
    }
    await this.run(job);
    return true;
  }

  heartbeats(): Record<string, Heartbeat> {
    const out: Record<string, Heartbeat> = {};
    for (const [name, job] of this.jobs) out[name] = { ...job.heartbeat };
    return out;
  }

  /** Stops all schedules and waits (up to timeoutMs) for in-flight runs. */
  async stopAll(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    this.stopController.abort();
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
    }
    const inFlight = [...this.jobs.values()]
      .map((job) => job.inFlight)
      .filter((p): p is Promise<void> => p !== null);
    if (inFlight.length === 0) return;
    if (!(await settleWithin(Promise.allSettled(inFlight), timeoutMs))) {
      this.deps.log.warn("jobs still running at shutdown", {
        jobs: [...this.jobs.values()].filter((j) => j.inFlight !== null).map((j) => j.name),
      });
    }
  }

  private schedule(job: Job, first: boolean): void {
    if (this.stopped) return;
    const jitter = job.options.jitterMs
      ? Math.floor((this.deps.random ?? Math.random)() * job.options.jitterMs)
      : 0;
    const base = first && job.options.runOnStart ? 0 : job.intervalMs;
    job.timer = setTimeout(() => {
      job.timer = null;
      // Schedule the next tick first so the cadence doesn't drift with run time.
      this.schedule(job, false);
      if (job.inFlight) {
        job.heartbeat.skipped++;
        this.deps.log.warn("job skipped: previous run still in flight", { job: job.name });
        return;
      }
      void this.run(job);
    }, base + jitter);
    // Never keep the process alive just for a timer.
    job.timer.unref?.();
  }

  private run(job: Job): Promise<void> {
    const { clock, log, alerter, metrics } = this.deps;
    const hb = job.heartbeat;
    const startedAt = clock.now();
    hb.lastStart = startedAt;
    hb.running = true;
    const promise = (async () => {
      try {
        // Run fn in a later microtask, so even a synchronous throw happens
        // after job.inFlight is set below (finally clears it).
        await Promise.resolve().then(() => job.fn(this.stopController.signal));
        hb.lastError = null;
        hb.consecutiveFailures = 0;
      } catch (err) {
        hb.failures++;
        hb.consecutiveFailures++;
        hb.lastError = err instanceof Error ? err.message : String(err);
        metrics?.inc(`jobs.${job.name}.failures`);
        log.error("job failed", {
          job: job.name,
          err,
          consecutiveFailures: hb.consecutiveFailures,
        });
        if (hb.consecutiveFailures >= ALERT_AFTER_FAILURES) {
          await alerter.alert(
            `job:${job.name}`,
            `Job "${job.name}" failed ${hb.consecutiveFailures} times in a row: ${hb.lastError}`,
          );
        }
      } finally {
        const endedAt = clock.now();
        hb.runs++;
        hb.lastEnd = endedAt;
        hb.lastDurationMs = endedAt - startedAt;
        hb.running = false;
        metrics?.inc(`jobs.${job.name}.runs`);
        job.inFlight = null;
      }
    })();
    job.inFlight = promise;
    return promise;
  }
}
