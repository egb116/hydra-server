import { z } from "zod";

/**
 * The RevenueCat app user id format every route accepts. It rejects `#`, `?`, `/`, `%` and whitespace, which
 * closes the RevenueCat URL-aliasing exploit. RevenueCat's anonymous ids
 * (`$RCAnonymousID:<hex>`) match.
 */
export const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9$:_.@+-]{1,128}$/;

export function isValidCustomerId(value: unknown): value is string {
  return typeof value === "string" && CUSTOMER_ID_PATTERN.test(value);
}

/** The zod field for a `customerId` in a request body. */
export const customerIdSchema = z
  .string()
  .regex(CUSTOMER_ID_PATTERN, "customerId must be 1-128 characters of A-Z a-z 0-9 $ : _ . @ + -");
