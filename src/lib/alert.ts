import type { Clock } from "./clock";
import { drain, type OutboundFetch } from "./http";
import type { Logger } from "./log";

export interface Alerter {
  /**
   * Sends an operator alert. Never throws. Alerts with the same `key` are
   * sent at most once per dedupe window.
   */
  alert(key: string, message: string): Promise<void>;
}

export const noopAlerter: Alerter = {
  alert: async () => {},
};

/** Discord caps messages at 2000 chars; leave room for the prefix. */
export const DISCORD_MAX_CHARS = 1900;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;
/** After a failed send, the same key may be retried this soon (not a whole window later). */
export const ALERT_RETRY_AFTER_FAILURE_MS = 60_000;

export interface DiscordAlerterOptions {
  webhookUrl: string;
  fetch: OutboundFetch;
  clock: Clock;
  log: Logger;
  /** Minimum time between two alerts with the same key. Default 1 h. */
  windowMs?: number;
}

export class DiscordAlerter implements Alerter {
  private readonly lastSent = new Map<string, number>();
  private readonly windowMs: number;

  constructor(private readonly options: DiscordAlerterOptions) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  async alert(key: string, message: string): Promise<void> {
    const { clock, log } = this.options;
    const now = clock.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.windowMs) {
      log.debug("alert suppressed", { key });
      return;
    }
    // Claim the window before sending so a burst sends only one message.
    this.lastSent.set(key, now);
    this.evict(now);
    const content =
      message.length > DISCORD_MAX_CHARS ? `${message.slice(0, DISCORD_MAX_CHARS - 1)}…` : message;
    let delivered = false;
    try {
      const res = await this.options.fetch(this.options.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        timeoutMs: TIMEOUT_MS,
      });
      delivered = res.ok;
      if (!res.ok) {
        log.warn("discord alert failed", { key, status: res.status });
      }
      await drain(res);
    } catch (err) {
      log.warn("discord alert failed", { key, err });
    }
    if (!delivered && this.lastSent.get(key) === now) {
      // Nothing reached the operator: give the key back after a short backoff
      // instead of suppressing it for the whole window.
      this.lastSent.set(key, now - this.windowMs + ALERT_RETRY_AFTER_FAILURE_MS);
    }
  }

  private evict(now: number): void {
    if (this.lastSent.size < 1000) return;
    for (const [k, t] of this.lastSent) {
      if (now - t >= this.windowMs) this.lastSent.delete(k);
    }
  }
}

export interface FailureRateAlertOptions {
  alerter: Alerter;
  clock: Clock;
  /** Length of each (tumbling) window per key. Default 15 min. */
  windowMs?: number;
  /** Failures a window needs before it alerts. Default 3. */
  minFailures?: number;
  /** Share of the window's outcomes that must have failed. Default 0.25. */
  minRatio?: number;
}

export const FAILURE_RATE_WINDOW_MS = 15 * 60 * 1000;
export const FAILURE_RATE_MIN_FAILURES = 3;
export const FAILURE_RATE_MIN_RATIO = 0.25;

/**
 * Alerts on a failure rate instead of on single failures, so one transient
 * upstream error (a timeout, a 503) doesn't page the operator. Each key keeps
 * a tumbling window of outcomes; a failure alerts once the window holds at
 * least `minFailures` failures that are at least `minRatio` of its outcomes.
 * The Alerter's per-key dedupe still applies on top.
 */
export class FailureRateAlert {
  private readonly windows = new Map<string, { start: number; ok: number; failed: number }>();
  private readonly windowMs: number;
  private readonly minFailures: number;
  private readonly minRatio: number;

  constructor(private readonly options: FailureRateAlertOptions) {
    this.windowMs = options.windowMs ?? FAILURE_RATE_WINDOW_MS;
    this.minFailures = options.minFailures ?? FAILURE_RATE_MIN_FAILURES;
    this.minRatio = options.minRatio ?? FAILURE_RATE_MIN_RATIO;
  }

  private window(key: string): { start: number; ok: number; failed: number } {
    const now = this.options.clock.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, ok: 0, failed: 0 };
      this.windows.set(key, w);
    }
    return w;
  }

  succeeded(key: string): void {
    this.window(key).ok++;
  }

  /** Records a failure and alerts (message + the window's counts) once the rate is reached. */
  failed(key: string, message: string): void {
    const w = this.window(key);
    w.failed++;
    const total = w.ok + w.failed;
    if (w.failed < this.minFailures || w.failed / total < this.minRatio) return;
    const minutes = Math.round(this.windowMs / 60_000);
    void this.options.alerter.alert(
      key,
      `${message} (${w.failed} of ${total} calls failed in the last ${minutes} min)`,
    );
  }
}
