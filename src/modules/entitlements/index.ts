import { HOUR_MS } from "../../lib/time";
import type { App, Module } from "../../types";
import type { EntitlementServiceImpl } from "./service";
import { registerWebhookRoute } from "./webhook";

export { createEntitlementService, type EntitlementServiceImpl } from "./service";
export { WEBHOOK_PATH } from "./webhook";

export const RECONCILE_JOB = "entitlements.reconcile";
export const RECONCILE_INTERVAL_MS = 6 * HOUR_MS;
/** Without the webhook, reconcile is the only way to notice cancellations. */
export const RECONCILE_INTERVAL_NO_WEBHOOK_MS = HOUR_MS;

/**
 * The webhook route (only when REVENUECAT_WEBHOOK_SECRET is set; otherwise the
 * path falls through to the JSON 404) and the reconcile job (official mode only).
 */
export function createEntitlementsModule(service: EntitlementServiceImpl): Module {
  const { config } = service.deps;
  const secret = config.revenuecat.webhookSecret;
  return {
    name: "entitlements",
    routes: (app: App) => {
      if (secret) registerWebhookRoute(app, service, secret);
    },
    jobs: (runner) => {
      if (config.mode === "selfhost") return;
      runner.every(
        RECONCILE_JOB,
        secret ? RECONCILE_INTERVAL_MS : RECONCILE_INTERVAL_NO_WEBHOOK_MS,
        // The runner aborts the signal as stopAll begins, so the run stops
        // asking about further customers at once.
        async (signal) => {
          await service.reconcile({ signal });
        },
        { runOnStart: true, jitterMs: 60_000 },
      );
    },
    // Halts a running reconcile, then waits for the calls already in flight.
    stop: () => service.stop(),
  };
}
