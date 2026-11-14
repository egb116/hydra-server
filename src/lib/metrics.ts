/**
 * In-process counters and gauges (name → number). Reset on restart; this is
 * for the /admin page and logs, not for long-term storage.
 */
export interface Metrics {
  /** Adds `by` (default 1) to a counter. */
  inc(name: string, by?: number): void;
  /** Sets a gauge. */
  set(name: string, value: number): void;
  get(name: string): number;
  snapshot(): Record<string, number>;
}

export function createMetrics(): Metrics {
  const values = new Map<string, number>();
  return {
    inc(name, by = 1) {
      values.set(name, (values.get(name) ?? 0) + by);
    },
    set(name, value) {
      values.set(name, value);
    },
    get(name) {
      return values.get(name) ?? 0;
    },
    snapshot() {
      return Object.fromEntries([...values.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
  };
}
