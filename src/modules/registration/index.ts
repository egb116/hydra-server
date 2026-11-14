import { Expo } from "expo-server-sdk";
import { z } from "zod";
import { readJson } from "../../http/body";
import { clientIp, clientNetworkKey } from "../../http/clientIp";
import type { SecretBox } from "../../lib/crypto";
import { TooManyRequests } from "../../lib/errors";
import { TokenBucket } from "../../lib/limiter";
import type { App, Deps, Module } from "../../types";
import type { EntitlementService } from "../contracts";
import { customerIdSchema } from "../../http/validation";
import { registerDevice } from "./devices";
import { pruneStaleDevices } from "./prune";

export { MAX_ACCOUNTS_PER_CUSTOMER, MAX_DEVICES_PER_CUSTOMER } from "./devices";
export { DEVICE_EXPIRY_MS, pruneOrphanAccounts, pruneStaleDevices } from "./prune";

export const MAX_PUSH_TOKEN_CHARS = 256;
export const MAX_ACCOUNTS = 50;
export const MAX_USERNAME_CHARS = 64;
export const MAX_SESSION_BYTES = 16 * 1024;

/**
 * A stored check older than this is refreshed for a customer who is already
 * entitled. The app only registers when it believes the user is Pro, so a
 * customer stored as not entitled (unknown, lapsed, expired) is rechecked
 * after NOT_ENTITLED_MAX_AGE_MS instead: a purchase made minutes after a
 * not-Pro check must not stay locked out until the next cold start.
 */
export const ENTITLED_MAX_AGE_MS = 10 * 60 * 1000;
export const NOT_ENTITLED_MAX_AGE_MS = 30 * 1000;

/**
 * Per client network (IPv6 by /64) and route: a burst of 20, then one request
 * every 3 s. The app registers on launch and when its accounts change.
 */
export const REGISTER_BURST = 20;
export const REGISTER_REFILL_PER_SECOND = 1 / 3;
/**
 * RevenueCat calls for customers not stored as entitled (new ids, lapsed
 * ones), across all clients: a burst of 60, then one a second. Refreshes for
 * entitled customers, the webhook and reconcile never wait on this, so an
 * anonymous flood can't use up the RevenueCat quota they depend on.
 */
export const UNENTITLED_REFRESH_BURST = 60;
export const UNENTITLED_REFRESH_PER_SECOND = 1;
/** How often expired devices, and the accounts and customers they leave behind, are pruned. */
export const PRUNE_STALE_JOB = "registration-prune-stale";
export const PRUNE_STALE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The legacy success body (v1 `new Response("success")`). */
export const SUCCESS_BODY = "success";

/** APP:api/Customer.ts sends {customerId, pushToken?}; pushToken is ignored, as in v1. */
const registerCustomerSchema = z.object({ customerId: customerIdSchema });

/**
 * APP:api/Notifications.ts sends {customerId, pushToken, accounts:[{username, session}]}.
 * pushToken comes from Notifications.getExpoPushTokenAsync() (APP:contexts/
 * SettingsContexts/NotificationsContext.tsx), so it is always an Expo token.
 */
const registerNotificationsSchema = z.object({
  customerId: customerIdSchema,
  pushToken: z
    .string()
    .min(1)
    .max(MAX_PUSH_TOKEN_CHARS)
    .refine((t) => Expo.isExpoPushToken(t), "pushToken must be an Expo push token"),
  accounts: z
    .array(
      z.object({
        username: z.string().min(1).max(MAX_USERNAME_CHARS),
        session: z
          .string()
          .refine(
            (s) => Buffer.byteLength(s, "utf8") <= MAX_SESSION_BYTES,
            `session must be at most ${MAX_SESSION_BYTES} bytes`,
          ),
      }),
    )
    .max(MAX_ACCOUNTS),
});

export interface RegistrationServices {
  entitlements: EntitlementService;
  secretBox: SecretBox;
}

/** POST /api/customers/register and POST /api/notifications/register. */
export function createRegistrationModule(
  deps: Pick<Deps, "config" | "db" | "sqlite" | "clock" | "log" | "metrics">,
  services: RegistrationServices,
): Module {
  const { entitlements } = services;
  const { clock, metrics } = deps;
  const selfhost = deps.config.mode === "selfhost";
  const perClient = new TokenBucket({
    capacity: REGISTER_BURST,
    refillPerSecond: REGISTER_REFILL_PER_SECOND,
    clock,
  });
  const unentitledRefreshes = new TokenBucket({
    capacity: UNENTITLED_REFRESH_BURST,
    refillPerSecond: UNENTITLED_REFRESH_PER_SECOND,
    clock,
    maxKeys: 1,
  });

  function throttle(route: string, ip: string): void {
    const taken = perClient.take(`${route}:${clientNetworkKey(ip)}`);
    if (!taken.ok) {
      metrics.inc(`registration.throttled.${route}`);
      throw new TooManyRequests("Throttled", { retryAfter: taken.retryAfterMs / 1000 });
    }
  }

  function storedAsEntitled(customerId: string): boolean {
    if (selfhost) return true;
    const row = entitlements.getCustomer(customerId);
    return row !== undefined && entitlements.isEntitled(row, clock.now());
  }

  /** RevenueCat is best-effort here: the app ignores the response either way. */
  async function refreshQuietly(customerId: string): Promise<void> {
    if (selfhost) return;
    try {
      if (storedAsEntitled(customerId)) {
        await entitlements.refreshIfStale(customerId, ENTITLED_MAX_AGE_MS);
        return;
      }
      const row = entitlements.getCustomer(customerId);
      const checkedAt = row?.entitlementCheckedAt;
      if (checkedAt != null && clock.now() - checkedAt < NOT_ENTITLED_MAX_AGE_MS) return;
      if (!unentitledRefreshes.take("all").ok) {
        metrics.inc("registration.refresh_budget_exhausted");
        deps.log.warn(
          "entitlement refresh skipped: the budget for unentitled customers is used up",
          {
            customerId,
          },
        );
        return;
      }
      await entitlements.refreshIfStale(customerId, NOT_ENTITLED_MAX_AGE_MS);
    } catch (err) {
      deps.log.warn("entitlement refresh during registration failed", { customerId, err });
    }
  }

  return {
    name: "registration",
    routes: (app: App) => {
      app.post("/api/customers/register", async (c) => {
        const { customerId } = await readJson(c, registerCustomerSchema);
        throttle("customers", clientIp(c));
        entitlements.ensureCustomer(customerId);
        await refreshQuietly(customerId);
        metrics.inc("registration.customers");
        return c.text(SUCCESS_BODY, 200);
      });

      app.post("/api/notifications/register", async (c) => {
        const input = await readJson(c, registerNotificationsSchema);
        throttle("notifications", clientIp(c));
        // Network first, outside the transaction.
        await refreshQuietly(input.customerId);
        // The app only enables notifications for Pro users, and only Pro
        // accounts are ever polled. Storing a non-Pro customer's sessions would
        // only hold secrets (and disk) for nothing. An empty list still goes
        // through: it only deletes.
        if (input.accounts.length > 0 && !storedAsEntitled(input.customerId)) {
          metrics.inc("registration.devices.not_entitled");
          c.get("log").info("notifications registration ignored: customer is not entitled", {
            customerId: input.customerId,
            accounts: input.accounts.length,
          });
          return c.text(SUCCESS_BODY, 200);
        }
        const result = registerDevice(deps, services, input);
        metrics.inc("registration.devices");
        c.get("log").info("notifications registered", {
          customerId: input.customerId,
          accounts: input.accounts.length,
          ...result,
        });
        return c.text(SUCCESS_BODY, 200);
      });
    },
    jobs: (runner) => {
      runner.every(
        PRUNE_STALE_JOB,
        PRUNE_STALE_INTERVAL_MS,
        () => {
          const result = pruneStaleDevices(deps.sqlite, clock.now());
          if (result.devices > 0 || result.customers > 0) {
            deps.log.info("pruned expired devices and lapsed customers", result);
          }
        },
        { runOnStart: true, jitterMs: 60_000 },
      );
    },
  };
}
