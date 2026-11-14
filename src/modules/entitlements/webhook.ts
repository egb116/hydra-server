import { z } from "zod";
import { readJson } from "../../http/body";
import { digestEquals } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import type { App } from "../../types";
import type { EntitlementServiceImpl } from "./service";

export const WEBHOOK_PATH = "/api/webhooks/revenuecat";

const idList = z.array(z.unknown()).nullish();

/**
 * Only the identity fields. Everything is optional because the event types
 * differ (TRANSFER carries transferred_from/transferred_to instead of
 * app_user_id) and an unknown shape must still get a 200, or RevenueCat retries.
 */
const webhookSchema = z.object({
  event: z
    .object({
      type: z.string().nullish(),
      id: z.string().nullish(),
      app_user_id: z.unknown().optional(),
      original_app_user_id: z.unknown().optional(),
      aliases: idList,
      transferred_from: idList,
      transferred_to: idList,
    })
    .nullish(),
});

export type RevenueCatWebhookBody = z.output<typeof webhookSchema>;

/** Every customer id the event names, deduped. Non-strings are dropped. */
export function webhookCustomerIds(body: RevenueCatWebhookBody): string[] {
  const event = body.event;
  if (!event) return [];
  const raw: unknown[] = [
    event.app_user_id,
    event.original_app_user_id,
    ...(event.aliases ?? []),
    ...(event.transferred_from ?? []),
    ...(event.transferred_to ?? []),
  ];
  return [...new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

/**
 * RevenueCat sends the configured "Authorization header value" as-is, so the
 * operator may have configured either the bare secret or "Bearer <secret>".
 * Both are accepted.
 */
export function isAuthorized(header: string | undefined, secret: string): boolean {
  if (header === undefined) return false;
  const got = header.trim();
  // Evaluate both comparisons so timing doesn't reveal which form matched.
  const bare = digestEquals(got, secret);
  const bearer = digestEquals(got, `Bearer ${secret}`);
  return bare || bearer;
}

/** POST /api/webhooks/revenuecat. Mount only when the secret is configured. */
export function registerWebhookRoute(
  app: App,
  service: EntitlementServiceImpl,
  secret: string,
): void {
  app.post(WEBHOOK_PATH, async (c) => {
    if (!isAuthorized(c.req.header("Authorization"), secret)) {
      service.deps.metrics.inc("entitlements.webhook.unauthorized");
      throw new AppError(401, "unauthorized", "Unauthorized");
    }
    const body = await readJson(c, webhookSchema);
    const ids = webhookCustomerIds(body);
    // The API stays the source of truth: refresh every known id in the
    // background and answer right away.
    const known = service.refreshKnownInBackground(ids);
    service.deps.metrics.inc("entitlements.webhook.events");
    c.get("log").info("revenuecat webhook", {
      type: body.event?.type ?? null,
      eventId: body.event?.id ?? null,
      ids: ids.length,
      known: known.length,
    });
    return c.json({ ok: true });
  });
}
