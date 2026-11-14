import type { FakeResponseSpec } from "./index";
import { PRO_ENTITLEMENT_ID } from "../../src/modules/entitlements/revenuecat";

export const RC_PROJECT = "proj1ab2c3d4";
export const RC_API_KEY = "sk_test_fake";
export const WEBHOOK_SECRET = "whsec-test-0123456789";

/** Official mode with RevenueCat configured (fake values). */
export const OFFICIAL_ENV = {
  HYDRA_MODE: "official",
  REVENUECAT_PROJECT_ID: RC_PROJECT,
  REVENUECAT_API_KEY: RC_API_KEY,
} as const;

export const OFFICIAL_WEBHOOK_ENV = {
  ...OFFICIAL_ENV,
  REVENUECAT_WEBHOOK_SECRET: WEBHOOK_SECRET,
} as const;

export function rcCustomerUrl(customerId: string): string {
  return `https://api.revenuecat.com/v2/projects/${RC_PROJECT}/customers/${encodeURIComponent(customerId)}`;
}

/** A RevenueCat v2 customer body, shaped like the API reference example. */
export function rcCustomer(
  items: { entitlement_id?: string; expires_at: number | null }[],
  nextPage: string | null = null,
): FakeResponseSpec {
  return {
    json: {
      object: "customer",
      id: "customer",
      project_id: RC_PROJECT,
      first_seen_at: 1_700_000_000_000,
      active_entitlements: {
        object: "list",
        items: items.map((i) => ({
          object: "customer.active_entitlement",
          entitlement_id: i.entitlement_id ?? PRO_ENTITLEMENT_ID,
          expires_at: i.expires_at,
        })),
        next_page: nextPage,
        url: "/v2/projects/x/customers/y/active_entitlements",
      },
    },
  };
}

/** A promise with its resolve exposed. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Builds a request exactly like the app does: a POST whose body is JSON text
 * with no Content-Type header (a byte body, so the runtime adds none).
 */
export function appPost(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  const bytes = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  return new Request(`http://localhost${path}`, { method: "POST", body: bytes, headers });
}
