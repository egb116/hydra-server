import { z } from "zod";
import { describeThrown } from "../../lib/errors";
import { drain, isAbortError, type OutboundFetch } from "../../lib/http";

/** v1 services/RevenueCat.ts: the "Hydra Pro" entitlement. */
export const PRO_ENTITLEMENT_ID = "entla7f4253fb6";
export const REVENUECAT_BASE_URL = "https://api.revenuecat.com";
export const REVENUECAT_TIMEOUT_MS = 8_000;
/**
 * GET /v2/projects/{pid}/customers/{id}. Only the fields we use; the rest is
 * ignored. active_entitlements holds one item per active entitlement, and
 * Hydra has one, so its first page is the whole answer.
 */
const customerSchema = z.object({
  active_entitlements: z.object({
    items: z.array(
      z.object({
        entitlement_id: z.string(),
        /** ms since epoch; null means it never expires (lifetime). */
        expires_at: z.number().nullable().optional(),
      }),
    ),
  }),
});

export type EntitlementLookup =
  /** RevenueCat answered 404: the customer does not exist there, so not Pro. */
  | { found: false }
  /** isPro: the Pro entitlement is active. expiresAt is null for no expiry. */
  | { found: true; isPro: boolean; expiresAt: number | null };

export type RevenueCatErrorKind =
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "parse"
  /** Any other non-2xx, for example 401/403 from a bad API key. */
  | "http";

/** An upstream failure. Callers keep the last known state. */
export class RevenueCatError extends Error {
  constructor(
    readonly kind: RevenueCatErrorKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = "RevenueCatError";
    this.retryAfterMs = options?.retryAfterMs;
  }

  /**
   * For rate_limited: how long RevenueCat asked us to wait, from the
   * Retry-After header (seconds) or the body's backoff_ms. Undefined when it
   * said neither.
   */
  readonly retryAfterMs: number | undefined;
}

/** Reads a 429's wait hint: Retry-After in seconds first, then the JSON body's backoff_ms. */
export function parseRetryAfterMs(headers: Headers, bodyText: string): number | undefined {
  const header = headers.get("retry-after")?.trim();
  if (header && /^\d+(\.\d+)?$/.test(header)) return Math.round(Number(header) * 1000);
  try {
    const body = JSON.parse(bodyText) as unknown;
    if (typeof body === "object" && body !== null && "backoff_ms" in body) {
      const ms = body.backoff_ms;
      if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
    }
  } catch {
    // Not JSON: no hint.
  }
  return undefined;
}

export interface RevenueCatClient {
  /** Throws RevenueCatError for anything but a 2xx or a 404. */
  getProEntitlement(customerId: string): Promise<EntitlementLookup>;
}

export interface RevenueCatClientOptions {
  fetch: OutboundFetch;
  projectId: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createRevenueCatClient(options: RevenueCatClientOptions): RevenueCatClient {
  const baseUrl = options.baseUrl ?? REVENUECAT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? REVENUECAT_TIMEOUT_MS;

  async function getJson(url: string): Promise<{ status: 404 } | { status: 200; body: unknown }> {
    let res: Response;
    try {
      res = await options.fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: "application/json",
        },
        timeoutMs,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new RevenueCatError(
          "timeout",
          `RevenueCat timed out after ${timeoutMs} ms`,
          undefined,
          {
            cause: err,
          },
        );
      }
      throw new RevenueCatError(
        "network",
        `RevenueCat request failed: ${describeThrown(err)}`,
        undefined,
        {
          cause: err,
        },
      );
    }
    if (res.status === 404) {
      await drain(res);
      return { status: 404 };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const kind: RevenueCatErrorKind =
        res.status === 429 ? "rate_limited" : res.status >= 500 ? "server" : "http";
      const retryAfterMs =
        kind === "rate_limited" ? parseRetryAfterMs(res.headers, text) : undefined;
      throw new RevenueCatError(
        kind,
        `RevenueCat answered ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        { retryAfterMs },
      );
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const kind = isAbortError(err) ? "timeout" : "network";
      throw new RevenueCatError(kind, "RevenueCat response body could not be read", res.status, {
        cause: err,
      });
    }
    try {
      return { status: 200, body: JSON.parse(text) as unknown };
    } catch (err) {
      throw new RevenueCatError("parse", "RevenueCat response is not JSON", res.status, {
        cause: err,
      });
    }
  }

  return {
    async getProEntitlement(customerId) {
      const first = await getJson(
        `${baseUrl}/v2/projects/${encodeURIComponent(options.projectId)}/customers/${encodeURIComponent(customerId)}`,
      );
      if (first.status === 404) return { found: false };
      const parsed = customerSchema.safeParse(first.body);
      if (!parsed.success) {
        throw new RevenueCatError(
          "parse",
          `RevenueCat customer has an unexpected shape: ${parsed.error.message.slice(0, 300)}`,
        );
      }
      const pro = parsed.data.active_entitlements.items.find(
        (item) => item.entitlement_id === PRO_ENTITLEMENT_ID,
      );
      return { found: true, isPro: pro !== undefined, expiresAt: pro?.expires_at ?? null };
    },
  };
}
