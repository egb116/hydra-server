/**
 * Expo's push HTTP API, called through deps.fetch. Mirrors expo-server-sdk
 * 8.0.0 (node_modules/expo-server-sdk/build/ExpoClient.js): the same
 * endpoints, headers, chunk sizes, 429 retry policy and error shapes. Only
 * the pure helper Expo.isExpoPushToken is used from the SDK itself, because
 * its client does its own I/O with the global fetch.
 */
import { Expo } from "expo-server-sdk";
import { isRecord, type OutboundFetch } from "../../lib/http";

export const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo.pushNotificationChunkSizeLimit */
export const SEND_CHUNK_LIMIT = 100;
/**
 * Expo.pushNotificationReceiptChunkSizeLimit. Expo's docs allow up to 1000 ids
 * per request; the SDK uses 300, and so do we.
 */
export const RECEIPT_CHUNK_LIMIT = 300;
/** The SDK's defaultConcurrentRequestLimit. */
export const DEFAULT_CONCURRENT_REQUESTS = 6;
/** The SDK retries a 429 twice with exponential backoff starting at 1 s (factor 2). */
export const RATE_LIMIT_RETRIES = 2;
export const RATE_LIMIT_MIN_TIMEOUT_MS = 1_000;
/** The SDK sets no timeout; every outbound request here must have one. */
export const EXPO_TIMEOUT_MS = 20_000;
const USER_AGENT = "expo-server-sdk-node/8.0.0";

export function isExpoPushToken(token: unknown): token is string {
  return Expo.isExpoPushToken(token);
}

/** An ok ticket carries a receipt id; an error ticket has the same shape as an error receipt. */
export type ExpoTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: { error?: string; expoPushToken?: string } };

export type ExpoReceipt =
  | { status: "ok"; details?: unknown }
  | { status: "error"; message: string; details?: { error?: string; expoPushToken?: string } };

/** An error from Expo's API, shaped like the SDK's (statusCode, code, details). */
export class ExpoApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | undefined,
    readonly code: string | undefined,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ExpoApiError";
  }
}

export interface ExpoRequestOptions {
  fetch: OutboundFetch;
  accessToken: string | null;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** The SDK's getErrorFromResult: the first error of `errors`, with the HTTP status. */
function errorFromResult(status: number, errors: unknown[]): ExpoApiError {
  const first = errors[0];
  const data = isRecord(first) ? first : {};
  const message = typeof data["message"] === "string" ? data["message"] : "Expo returned an error";
  const code = typeof data["code"] === "string" ? data["code"] : undefined;
  return new ExpoApiError(message, status, code, data["details"]);
}

/** POSTs JSON to an Expo endpoint and returns `data`, or throws ExpoApiError (the SDK's requestAsync). */
async function requestOnce(url: string, body: unknown, options: ExpoRequestOptions) {
  const headers = new Headers({
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
  });
  if (options.accessToken) headers.set("Authorization", `Bearer ${options.accessToken}`);
  const response = await options.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs: options.timeoutMs ?? EXPO_TIMEOUT_MS,
  });
  const text = await response.text();
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new ExpoApiError(
      `Expo responded with an error with status code ${response.status}: ${text.slice(0, 500)}`,
      response.status,
      undefined,
    );
  }
  const errors = isRecord(result) ? result["errors"] : undefined;
  if (Array.isArray(errors) && errors.length > 0) throw errorFromResult(response.status, errors);
  if (response.status !== 200) {
    throw new ExpoApiError(
      `Expo responded with an error with status code ${response.status}: ${text.slice(0, 500)}`,
      response.status,
      undefined,
    );
  }
  return isRecord(result) ? result["data"] : undefined;
}

/** requestOnce with the SDK's retry on 429 (2 retries, 1 s then 2 s). */
async function request(url: string, body: unknown, options: ExpoRequestOptions): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(url, body, options);
    } catch (err) {
      if (err instanceof ExpoApiError && err.statusCode === 429 && attempt < RATE_LIMIT_RETRIES) {
        await options.sleep(RATE_LIMIT_MIN_TIMEOUT_MS * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

function isTicket(value: unknown): value is ExpoTicket {
  if (!isRecord(value)) return false;
  if (value["status"] === "ok") return typeof value["id"] === "string";
  return value["status"] === "error";
}

function isReceipt(value: unknown): value is ExpoReceipt {
  return isRecord(value) && (value["status"] === "ok" || value["status"] === "error");
}

/** Sends one chunk (at most SEND_CHUNK_LIMIT messages). Returns one ticket per message, in order. */
export async function sendChunk(
  messages: readonly object[],
  options: ExpoRequestOptions,
): Promise<ExpoTicket[]> {
  const data = await request(EXPO_SEND_URL, messages, options);
  if (!Array.isArray(data) || data.length !== messages.length) {
    const got = Array.isArray(data) ? data.length : typeof data;
    throw new ExpoApiError(
      `Expected Expo to respond with ${messages.length} ${messages.length === 1 ? "ticket" : "tickets"} but got ${String(got)}`,
      200,
      undefined,
    );
  }
  return data.map((ticket): ExpoTicket => {
    if (isTicket(ticket)) return ticket;
    return { status: "error", message: "malformed ticket from Expo" };
  });
}

/** Fetches receipts for at most RECEIPT_CHUNK_LIMIT ids. Ids without a receipt yet are absent. */
export async function getReceipts(
  ids: readonly string[],
  options: ExpoRequestOptions,
): Promise<Map<string, ExpoReceipt>> {
  const data = await request(EXPO_RECEIPTS_URL, { ids }, options);
  if (!isRecord(data)) {
    throw new ExpoApiError(
      "Expected Expo to respond with a map from receipt IDs to receipts but received data of another type",
      200,
      undefined,
    );
  }
  const out = new Map<string, ExpoReceipt>();
  for (const [id, receipt] of Object.entries(data)) {
    if (isReceipt(receipt)) out.set(id, receipt);
  }
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
