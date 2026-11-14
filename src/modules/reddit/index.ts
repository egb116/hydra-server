import type { Module } from "../../types";
import { REFRESH_INTERVAL_MS, type RefreshableProxyPool } from "./proxyPool";

export { createRedditClient } from "./client";
export { createProxyPool } from "./proxyPool";

export const PROXY_REFRESH_JOB = "reddit.proxyRefresh";

/**
 * The reddit module: no routes, just the hourly proxy list refresh and the
 * pool's health. The client and pool are built in main.ts and shared with the
 * poller.
 *
 * health() always reports ok: a proxy outage stops polling (and alerts) but the
 * app-facing API (AI, registration) keeps working, so it must not fail /healthz.
 * `detail.degraded` says whether polling can currently run.
 */
export function createRedditModule(pool: RefreshableProxyPool): Module {
  return {
    name: "reddit",
    jobs: (runner) => {
      if (!pool.enabled) return;
      runner.every(
        PROXY_REFRESH_JOB,
        REFRESH_INTERVAL_MS,
        async () => {
          if (!(await pool.refresh())) {
            // The pool already logged and alerted; fail the run so the heartbeat shows it.
            throw new Error(pool.health().lastRefreshError ?? "proxy refresh failed");
          }
        },
        { runOnStart: true },
      );
    },
    health: () => {
      const snapshot = pool.health();
      return {
        ok: true,
        detail: { ...snapshot, degraded: snapshot.configured && snapshot.healthy === 0 },
      };
    },
  };
}
