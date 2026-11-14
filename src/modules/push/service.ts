import { FailureRateAlert } from "../../lib/alert";
import { describeThrown } from "../../lib/errors";
import { createLimiter } from "../../lib/limiter";
import { MINUTE_MS } from "../../lib/time";
import type { Deps } from "../../types";
import type {
  PruneOrphanAccounts,
  PushMessage,
  PushSendOptions,
  PushSendResult,
  PushService,
  RemoveDeviceOptions,
} from "../contracts";
import {
  chunk,
  DEFAULT_CONCURRENT_REQUESTS,
  ExpoApiError,
  type ExpoReceipt,
  type ExpoRequestOptions,
  type ExpoTicket,
  getReceipts,
  isExpoPushToken,
  RECEIPT_CHUNK_LIMIT,
  SEND_CHUNK_LIMIT,
  sendChunk,
} from "./expo";

/** Receipts are fetched for tickets at least this old. */
export const RECEIPT_MIN_AGE_MS = 15 * MINUTE_MS;
/** Expo keeps receipts for about a day; older tickets are dropped unchecked. */
export const TICKET_MAX_AGE_MS = 24 * 60 * MINUTE_MS;
/** Upper bound on tickets checked per receipts run (oldest first). */
export const RECEIPTS_PER_RUN = 30_000;
/**
 * Concurrent receipt requests. Receipts have their own limiter, so a receipts
 * run (up to 100 requests) never queues ahead of the poller's sends.
 */
export const RECEIPT_CONCURRENT_REQUESTS = 2;

const DEVICE_NOT_REGISTERED = "DeviceNotRegistered";

export interface ReceiptsRunResult {
  checked: number;
  ok: number;
  errors: number;
  /** Tickets whose receipt is not available yet (kept for the next run). */
  pending: number;
  /** Tickets dropped because they are older than 24 h. */
  expired: number;
  devicesRemoved: number;
}

export interface PushServiceImpl extends PushService {
  /** The receipts job: fetch receipts for tickets older than 15 min, prune dead devices, delete processed and expired tickets. */
  processReceipts(): Promise<ReceiptsRunResult>;
  /** Number of stored tickets awaiting a receipt. */
  pendingTickets(): number;
}

export interface PushServiceOptions {
  /** registration/prune.ts pruneOrphanAccounts. */
  prune: PruneOrphanAccounts;
  /** Concurrent Expo requests across all sends (the SDK's default is 6). */
  maxConcurrentRequests?: number;
  /** For tests: replaces the 429 backoff wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface TicketRow {
  ticketId: string;
  pushToken: string;
  createdAt: number;
}

export function createPushService(deps: Deps, options: PushServiceOptions): PushServiceImpl {
  const { sqlite, clock, metrics } = deps;
  const log = deps.log.child({ module: "push" });
  const limit = createLimiter(options.maxConcurrentRequests ?? DEFAULT_CONCURRENT_REQUESTS);
  const receiptsLimit = createLimiter(RECEIPT_CONCURRENT_REQUESTS);
  const failureRate = new FailureRateAlert({ alerter: deps.alerter, clock });
  const expo: ExpoRequestOptions = {
    fetch: deps.fetch,
    accessToken: deps.config.expoAccessToken,
    sleep: options.sleep ?? realSleep,
  };

  const insertTicket = sqlite.query<unknown, { ticketId: string; pushToken: string; now: number }>(
    `INSERT OR IGNORE INTO push_tickets (ticket_id, push_token, created_at)
     VALUES ($ticketId, $pushToken, $now)`,
  );
  // registeredBefore: a device that registered again after the ticket was sent
  // is a fresh registration (a reinstall can keep the Expo token), so a late
  // DeviceNotRegistered receipt must not delete it.
  const deleteDevice = sqlite.query<unknown, { pushToken: string; registeredBefore: number }>(
    `DELETE FROM devices
     WHERE push_token = $pushToken AND last_registered_at <= $registeredBefore`,
  );

  const removeDeviceTx = sqlite.transaction((pushToken: string, registeredBefore: number) => {
    const deleted = deleteDevice.run({ pushToken, registeredBefore }).changes;
    const pruned = deleted > 0 ? options.prune(sqlite) : 0;
    return { deleted, pruned };
  });

  function removeDeviceCounted(pushToken: string, removeOptions: RemoveDeviceOptions): number {
    const registeredBefore = removeOptions.registeredBefore ?? Number.MAX_SAFE_INTEGER;
    const { deleted, pruned } = removeDeviceTx(pushToken, registeredBefore);
    if (deleted > 0) {
      metrics.inc("push.devices_removed");
      if (pruned > 0) metrics.inc("push.accounts_pruned", pruned);
      log.info("removed unregistered device", {
        token: redactToken(pushToken),
        accountsPruned: pruned,
      });
    }
    return deleted;
  }

  function removeDevice(pushToken: string, removeOptions: RemoveDeviceOptions = {}): void {
    removeDeviceCounted(pushToken, removeOptions);
  }

  /** Whether a device was deleted. Never throws: a failure must not lose the rest of the batch. */
  function safeRemoveDevice(pushToken: string, removeOptions: RemoveDeviceOptions = {}): boolean {
    try {
      return removeDeviceCounted(pushToken, removeOptions) > 0;
    } catch (err) {
      log.error("removing device failed", { token: redactToken(pushToken), err });
      return false;
    }
  }

  function countError(prefix: string, error: string | undefined): void {
    metrics.inc(`${prefix}.${error ?? "unknown"}`);
    if (error === "InvalidCredentials") {
      void deps.alerter.alert(
        "push:invalid-credentials",
        "Expo reports InvalidCredentials: the push credentials for the app are misconfigured.",
      );
    }
  }

  async function sendOne(
    messages: readonly PushMessage[],
    signal: AbortSignal | undefined,
  ): Promise<PushSendResult> {
    let tickets: ExpoTicket[] | null;
    try {
      tickets = await limit(() =>
        // Still queued when the caller gave up (a stalled Expo): drop it rather
        // than deliver a stale notification minutes later.
        signal?.aborted ? Promise.resolve(null) : sendChunk(messages.map(toExpoMessage), expo),
      );
    } catch (err) {
      metrics.inc("push.request_errors");
      const fields = errorFields(err);
      log.error("expo push request failed", { messages: messages.length, ...fields });
      failureRate.failed("push:send-failed", `Expo push requests are failing: ${fields.error}`);
      return { sent: 0, failed: messages.length };
    }
    if (tickets === null) {
      metrics.inc("push.skipped_aborted", messages.length);
      log.warn("dropped a queued push: the caller gave up waiting", { messages: messages.length });
      return { sent: 0, failed: messages.length };
    }
    failureRate.succeeded("push:send-failed");
    const now = clock.now();
    let sent = 0;
    let failed = 0;
    const dead = new Set<string>();
    const store = sqlite.transaction(() => {
      tickets.forEach((ticket, i) => {
        const message = messages[i];
        if (!message) return;
        if (ticket.status === "ok") {
          insertTicket.run({ ticketId: ticket.id, pushToken: message.to, now });
          sent++;
          return;
        }
        failed++;
        const error = ticket.details?.error;
        countError("push.ticket_error", error);
        if (error === DEVICE_NOT_REGISTERED) {
          dead.add(message.to);
        } else {
          log.warn("expo push ticket error", {
            token: redactToken(message.to),
            error,
            message: ticket.message,
          });
        }
      });
    });
    try {
      store();
    } catch (err) {
      // The pushes went out; only the receipt bookkeeping is lost.
      log.error("storing push tickets failed", { err });
    }
    for (const token of dead) safeRemoveDevice(token);
    return { sent, failed };
  }

  async function send(
    messages: readonly PushMessage[],
    sendOptions: PushSendOptions = {},
  ): Promise<PushSendResult> {
    let failed = 0;
    const valid: PushMessage[] = [];
    for (const message of messages) {
      if (isExpoPushToken(message.to)) {
        valid.push(message);
      } else {
        failed++;
        metrics.inc("push.invalid_token");
        log.warn("skipping push to an invalid Expo token", { token: redactToken(message.to) });
      }
    }
    let sent = 0;
    try {
      const results = await Promise.all(
        chunk(valid, SEND_CHUNK_LIMIT).map((c) => sendOne(c, sendOptions.signal)),
      );
      for (const r of results) {
        sent += r.sent;
        failed += r.failed;
      }
    } catch (err) {
      // sendOne never throws; this is a last-resort guard for the contract.
      log.error("push send failed", { err });
      failed = messages.length - sent;
    }
    metrics.inc("push.sent", sent);
    metrics.inc("push.failed", failed);
    return { sent, failed };
  }

  const selectDue = sqlite.query<TicketRow, { before: number; after: number; limit: number }>(
    `SELECT ticket_id AS ticketId, push_token AS pushToken, created_at AS createdAt FROM push_tickets
     WHERE created_at <= $before AND created_at > $after
     ORDER BY created_at LIMIT $limit`,
  );
  const deleteExpired = sqlite.query<unknown, { after: number }>(
    "DELETE FROM push_tickets WHERE created_at <= $after",
  );
  const deleteTickets = sqlite.query<unknown, { ids: string }>(
    "DELETE FROM push_tickets WHERE ticket_id IN (SELECT value FROM json_each($ids))",
  );
  const countTickets = sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM push_tickets");

  async function processReceipts(): Promise<ReceiptsRunResult> {
    const now = clock.now();
    const result: ReceiptsRunResult = {
      checked: 0,
      ok: 0,
      errors: 0,
      pending: 0,
      expired: 0,
      devicesRemoved: 0,
    };
    result.expired = deleteExpired.run({ after: now - TICKET_MAX_AGE_MS }).changes;
    const due = selectDue.all({
      before: now - RECEIPT_MIN_AGE_MS,
      after: now - TICKET_MAX_AGE_MS,
      limit: RECEIPTS_PER_RUN,
    });
    const ticketById = new Map(due.map((t) => [t.ticketId, t]));
    const failures: string[] = [];

    for (const ids of chunk([...ticketById.keys()], RECEIPT_CHUNK_LIMIT)) {
      let receipts: Map<string, ExpoReceipt>;
      try {
        receipts = await receiptsLimit(() => getReceipts(ids, expo));
      } catch (err) {
        metrics.inc("push.receipts.request_errors");
        const fields = errorFields(err);
        log.error("expo receipts request failed", { ids: ids.length, ...fields });
        failures.push(fields.error);
        continue;
      }
      const processed: string[] = [];
      /** Dead token → the newest ticket time that said so. */
      const dead = new Map<string, number>();
      for (const id of ids) {
        const receipt = receipts.get(id);
        if (!receipt) {
          result.pending++;
          continue;
        }
        processed.push(id);
        result.checked++;
        if (receipt.status === "ok") {
          result.ok++;
          continue;
        }
        result.errors++;
        const error = receipt.details?.error;
        countError("push.receipt_error", error);
        const ticket = ticketById.get(id);
        const token = ticket?.pushToken ?? receipt.details?.expoPushToken;
        if (error === DEVICE_NOT_REGISTERED && token) {
          const sentAt = ticket?.createdAt ?? now - TICKET_MAX_AGE_MS;
          dead.set(token, Math.max(dead.get(token) ?? -Infinity, sentAt));
        } else {
          log.warn("expo push receipt error", {
            token: token ? redactToken(token) : undefined,
            error,
            message: receipt.message,
          });
        }
      }
      for (const [token, sentAt] of dead) {
        // Only a device that hasn't registered again since the push was sent.
        if (safeRemoveDevice(token, { registeredBefore: sentAt })) result.devicesRemoved++;
      }
      deleteTickets.run({ ids: JSON.stringify(processed) });
    }

    metrics.inc("push.receipts.ok", result.ok);
    metrics.inc("push.receipts.errors", result.errors);
    metrics.set("push.tickets.pending", pendingTickets());
    log.info("push receipts processed", { ...result });
    if (failures.length > 0) {
      throw new Error(`${failures.length} Expo receipt request(s) failed: ${failures[0] ?? ""}`);
    }
    return result;
  }

  function pendingTickets(): number {
    return countTickets.get()?.n ?? 0;
  }

  return { send, removeDevice, processReceipts, pendingTickets };
}

function toExpoMessage(message: PushMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    to: message.to,
    title: message.title,
    body: message.body,
  };
  if (message.badge !== undefined) out["badge"] = message.badge;
  if (message.sound !== undefined) out["sound"] = message.sound;
  if (message.data !== undefined) out["data"] = message.data;
  return out;
}

function errorFields(err: unknown): { error: string; statusCode?: number; code?: string } {
  if (err instanceof ExpoApiError) {
    return {
      error: err.message,
      ...(err.statusCode === undefined ? {} : { statusCode: err.statusCode }),
      ...(err.code === undefined ? {} : { code: err.code }),
    };
  }
  return { error: describeThrown(err) };
}

/** Logs only a prefix of a push token. */
function redactToken(token: string): string {
  return token.length > 24 ? `${token.slice(0, 24)}…` : token;
}
