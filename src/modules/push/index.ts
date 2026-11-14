import type { Module } from "../../types";
import type { PushServiceImpl } from "./service";

export { createPushService } from "./service";

export const RECEIPTS_JOB = "push-receipts";
export const RECEIPTS_INTERVAL_MS = 15 * 60_000;

/**
 * The push module: the receipts job every 15 min. Sending happens through the
 * PushService the poller is given; counters live under push.* in metrics.
 */
export function createPushModule(service: PushServiceImpl): Module {
  return {
    name: "push",
    jobs: (runner) => {
      runner.every(
        RECEIPTS_JOB,
        RECEIPTS_INTERVAL_MS,
        async () => {
          await service.processReceipts();
        },
        { jitterMs: 30_000 },
      );
    },
  };
}
