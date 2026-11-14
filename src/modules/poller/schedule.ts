/**
 * Pure scheduling rules for an account after a check.
 */
import { HOUR_MS, MINUTE_MS } from "../../lib/time";

/** Transient failures back off to at most this (before jitter). */
export const MAX_BACKOFF_MS = 30 * MINUTE_MS;
/** session_dead failures in a row before the account is marked needs_reauth. */
export const SESSION_DEAD_THRESHOLD = 2;

export type Random = () => number;

/** POLL_INTERVAL_MS × (0.9–1.1). */
export function successDelay(intervalMs: number, random: Random): number {
  return Math.round(intervalMs * (0.9 + 0.2 * random()));
}

/** min(POLL_INTERVAL_MS × 2^(n-1), 30 min) × (0.9–1.1), where n is the new consecutive failure count. */
export function transientDelay(intervalMs: number, failures: number, random: Random): number {
  const n = Math.max(1, failures);
  const base = Math.min(intervalMs * 2 ** Math.min(n - 1, 30), MAX_BACKOFF_MS);
  return Math.round(base * (0.9 + 0.2 * random()));
}

/** A session_dead below the threshold: retry in 2–5 min. */
export function sessionRetryDelay(random: Random): number {
  return Math.round((2 + 3 * random()) * MINUTE_MS);
}

/** needs_reauth: 11–12 h, like v1 (the spread keeps these accounts from all coming back at once). */
export function reauthDelay(random: Random): number {
  return Math.round((11 + random()) * HOUR_MS);
}
