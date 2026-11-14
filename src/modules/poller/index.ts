import type { Module } from "../../types";
import type { Poller } from "./poller";

export { createPoller, type Poller } from "./poller";

export const PRUNE_NOTIFIED_JOB = "poller-prune-notified";
export const PRUNE_NOTIFIED_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The poller module: the 1 s claim loop (start/stop), its heartbeat, and the daily outbox prune. */
export function createPollerModule(poller: Poller): Module {
  return {
    name: "poller",
    start: () => poller.start(),
    stop: () => poller.stop(),
    health: () => poller.health(),
    jobs: (runner) => {
      runner.every(
        PRUNE_NOTIFIED_JOB,
        PRUNE_NOTIFIED_INTERVAL_MS,
        () => {
          poller.pruneNotifiedItems();
        },
        { runOnStart: true, jitterMs: 60_000 },
      );
    },
  };
}
