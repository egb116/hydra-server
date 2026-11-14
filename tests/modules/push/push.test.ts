import { afterEach, describe, expect, test } from "bun:test";
import { secretBoxFromConfig } from "../../../src/lib/crypto";
import type { PushMessage } from "../../../src/modules/contracts";
import { createPushModule, createPushService, RECEIPTS_JOB } from "../../../src/modules/push";
import { EXPO_RECEIPTS_URL, EXPO_SEND_URL } from "../../../src/modules/push/expo";
import { RECEIPT_MIN_AGE_MS, TICKET_MAX_AGE_MS } from "../../../src/modules/push/service";
import { pruneOrphanAccounts } from "../../../src/modules/registration/prune";
import { type FetchCall, rejection, testDeps, type TestDeps } from "../../helpers";
import {
  deferred,
  link,
  seedAccount,
  seedCustomer,
  seedDevice,
  VALID_TOKEN,
} from "../../helpers/poller-push";

const MIN = 60_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function setup(env: Record<string, string> = {}, maxConcurrentRequests?: number) {
  const deps = await testDeps({ env });
  cleanups.push(deps.cleanup);
  const sleeps: number[] = [];
  const service = createPushService(deps, {
    prune: pruneOrphanAccounts,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
  });
  return { deps, service, sleeps };
}

function msg(to: string, i = 0): PushMessage {
  return { to, title: `t${i}`, body: `b${i}`, badge: 1, sound: "default", data: { i } };
}

function sentBody(call: FetchCall): Record<string, unknown>[] {
  return JSON.parse(call.body ?? "[]") as Record<string, unknown>[];
}

/** Answers every send with one ok ticket per message, ids from the message index. */
function okTickets(deps: TestDeps): void {
  let n = 0;
  deps.fetch.on("POST", EXPO_SEND_URL, (call) => ({
    json: { data: sentBody(call).map(() => ({ status: "ok", id: `ticket-${n++}` })) },
  }));
}

function tickets(deps: TestDeps) {
  return deps.sqlite
    .query<{ ticket_id: string; push_token: string; created_at: number }, []>(
      "SELECT ticket_id, push_token, created_at FROM push_tickets ORDER BY id",
    )
    .all();
}

function count(deps: TestDeps, table: string): number {
  return deps.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
}

describe("send", () => {
  test("chunks at 100 messages and mirrors the SDK's request", async () => {
    const { deps, service } = await setup({ EXPO_ACCESS_TOKEN: "expo-secret" });
    okTickets(deps);
    const messages = Array.from({ length: 250 }, (_, i) => msg(VALID_TOKEN(i), i));
    expect(await service.send(messages)).toEqual({ sent: 250, failed: 0 });

    const calls = deps.fetch.calls;
    expect(calls.map((c) => sentBody(c).length)).toEqual([100, 100, 50]);
    const first = calls[0]!;
    expect(first.url).toBe("https://exp.host/--/api/v2/push/send");
    expect(first.method).toBe("POST");
    expect(first.headers.get("authorization")).toBe("Bearer expo-secret");
    expect(first.headers.get("content-type")).toBe("application/json");
    expect(first.headers.get("accept")).toBe("application/json");
    expect(first.init.timeoutMs).toBeGreaterThan(0);
    expect(sentBody(first)[0]).toEqual({
      to: VALID_TOKEN(0),
      title: "t0",
      body: "b0",
      badge: 1,
      sound: "default",
      data: { i: 0 },
    });
    expect(tickets(deps)).toHaveLength(250);
    expect(tickets(deps)[0]).toEqual({
      ticket_id: "ticket-0",
      push_token: VALID_TOKEN(0),
      created_at: deps.clock.now(),
    });
    expect(deps.metrics.get("push.sent")).toBe(250);
  });

  test("sends no Authorization header without EXPO_ACCESS_TOKEN", async () => {
    const { deps, service } = await setup();
    okTickets(deps);
    await service.send([msg(VALID_TOKEN(1))]);
    expect(deps.fetch.calls[0]?.headers.has("authorization")).toBe(false);
  });

  test("skips invalid tokens and counts them as failed", async () => {
    const { deps, service } = await setup();
    okTickets(deps);
    const result = await service.send([msg("not-a-token"), msg(VALID_TOKEN(1)), msg("")]);
    expect(result).toEqual({ sent: 1, failed: 2 });
    expect(deps.fetch.calls).toHaveLength(1);
    expect(sentBody(deps.fetch.calls[0]!).map((m) => m["to"])).toEqual([VALID_TOKEN(1)]);
    expect(deps.metrics.get("push.invalid_token")).toBe(2);
  });

  test("sends nothing for an empty batch", async () => {
    const { deps, service } = await setup();
    expect(await service.send([])).toEqual({ sent: 0, failed: 0 });
    expect(deps.fetch.calls).toEqual([]);
  });

  test("a DeviceNotRegistered ticket removes the device and prunes its orphaned accounts", async () => {
    const { deps, service } = await setup();
    const now = deps.clock.now();
    const sql = deps.sqlite;
    const box = secretBoxFromConfig(deps.config);
    const cid = seedCustomer(sql, now);
    const dead = seedDevice(sql, cid, VALID_TOKEN("dead"), now);
    const alive = seedDevice(sql, cid, VALID_TOKEN("alive"), now);
    const onlyDead = seedAccount(sql, box, cid, now, { username: "only-dead" });
    const shared = seedAccount(sql, box, cid, now, { username: "shared" });
    link(sql, dead, onlyDead);
    link(sql, dead, shared);
    link(sql, alive, shared);

    deps.fetch.on("POST", EXPO_SEND_URL, {
      json: {
        data: [
          {
            status: "error",
            message:
              '"ExponentPushToken[device-dead]" is not a registered push notification recipient',
            details: { error: "DeviceNotRegistered", expoPushToken: VALID_TOKEN("dead") },
          },
          { status: "ok", id: "ticket-alive" },
        ],
      },
    });
    const result = await service.send([msg(VALID_TOKEN("dead")), msg(VALID_TOKEN("alive"))]);
    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(sql.query("SELECT push_token FROM devices").all()).toEqual([
      { push_token: VALID_TOKEN("alive") },
    ]);
    expect(sql.query("SELECT username FROM reddit_accounts").all()).toEqual([
      { username: "shared" },
    ]);
    expect(tickets(deps).map((t) => t.ticket_id)).toEqual(["ticket-alive"]);
    expect(deps.metrics.get("push.devices_removed")).toBe(1);
    expect(deps.metrics.get("push.ticket_error.DeviceNotRegistered")).toBe(1);
  });

  test("other ticket errors are counted but keep the device", async () => {
    const { deps, service } = await setup();
    const now = deps.clock.now();
    seedDevice(deps.sqlite, seedCustomer(deps.sqlite, now), VALID_TOKEN(1), now);
    deps.fetch.on("POST", EXPO_SEND_URL, {
      json: {
        data: [{ status: "error", message: "too big", details: { error: "MessageTooBig" } }],
      },
    });
    expect(await service.send([msg(VALID_TOKEN(1))])).toEqual({ sent: 0, failed: 1 });
    expect(count(deps, "devices")).toBe(1);
    expect(deps.metrics.get("push.ticket_error.MessageTooBig")).toBe(1);
  });

  test("a failed request fails its chunk and never throws", async () => {
    const { deps, service } = await setup();
    let n = 0;
    deps.fetch.on("POST", EXPO_SEND_URL, (call) =>
      n++ === 0
        ? {
            status: 400,
            json: { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS", message: "mixed projects" }] },
          }
        : { json: { data: sentBody(call).map((_, i) => ({ status: "ok", id: `x${i}` })) } },
    );
    const messages = Array.from({ length: 150 }, (_, i) => msg(VALID_TOKEN(i), i));
    expect(await service.send(messages)).toEqual({ sent: 50, failed: 100 });
    // One failed request is routine noise: logged, not paged.
    expect(deps.alerter.alerts).toEqual([]);
    const logged = deps.log.lines.find((l) => l["msg"] === "expo push request failed");
    expect(logged).toMatchObject({ code: "PUSH_TOO_MANY_EXPERIENCE_IDS", statusCode: 400 });
  });

  test("network errors, non-JSON bodies and ticket count mismatches fail the chunk", async () => {
    const { deps, service } = await setup();
    deps.fetch.enqueue(new Error("socket hang up"));
    deps.fetch.enqueue({ status: 502, body: "<html>bad gateway</html>" });
    deps.fetch.enqueue({ json: { data: [] } });
    for (let i = 0; i < 3; i++) {
      expect(await service.send([msg(VALID_TOKEN(i))])).toEqual({ sent: 0, failed: 1 });
    }
    expect(deps.metrics.get("push.request_errors")).toBe(3);
  });

  test("retries a 429 twice with 1 s and 2 s backoff, like the SDK", async () => {
    const { deps, service, sleeps } = await setup();
    deps.fetch.enqueue({ status: 429, json: { errors: [{ code: "RATE", message: "slow down" }] } });
    deps.fetch.enqueue({ status: 429, body: "Too Many Requests" });
    deps.fetch.enqueue({ json: { data: [{ status: "ok", id: "after-retry" }] } });
    expect(await service.send([msg(VALID_TOKEN(1))])).toEqual({ sent: 1, failed: 0 });
    expect(sleeps).toEqual([1_000, 2_000]);

    for (let i = 0; i < 3; i++) deps.fetch.enqueue({ status: 429, body: "Too Many Requests" });
    expect(await service.send([msg(VALID_TOKEN(2))])).toEqual({ sent: 0, failed: 1 });
    expect(deps.fetch.calls).toHaveLength(6);
  });

  // A single transient Expo failure must not page; a sustained failure rate must.
  test("alerts push:send-failed only on a failure rate", async () => {
    const { deps, service } = await setup();
    deps.fetch.on("POST", EXPO_SEND_URL, { status: 503, body: "unavailable" });
    expect(await service.send([msg(VALID_TOKEN(1))])).toEqual({ sent: 0, failed: 1 });
    expect(await service.send([msg(VALID_TOKEN(2))])).toEqual({ sent: 0, failed: 1 });
    expect(deps.alerter.alerts).toEqual([]);
    expect(await service.send([msg(VALID_TOKEN(3))])).toEqual({ sent: 0, failed: 1 });
    expect(deps.alerter.alerts.map((a) => a.key)).toEqual(["push:send-failed"]);
    expect(deps.alerter.alerts[0]!.message).toContain("3 of 3 calls failed");
  });

  // A hung Expo used to leave queued sends to go out minutes later, after the
  // poller's check had given up: stale notifications.
  test("drops chunks still queued when the caller's signal aborts", async () => {
    const { deps, service } = await setup({}, 1);
    const gate = deferred();
    deps.fetch.on("POST", EXPO_SEND_URL, async (call) => {
      await gate.promise;
      return { json: { data: sentBody(call).map((_, i) => ({ status: "ok", id: `t${i}` })) } };
    });
    const controller = new AbortController();
    const first = service.send([msg(VALID_TOKEN(1))], { signal: controller.signal });
    const queued = service.send([msg(VALID_TOKEN(2))], { signal: controller.signal });
    await Bun.sleep(5);
    expect(deps.fetch.calls).toHaveLength(1);
    controller.abort();
    gate.resolve();
    // The one already sent completes; the queued one is never sent.
    expect(await first).toEqual({ sent: 1, failed: 0 });
    expect(await queued).toEqual({ sent: 0, failed: 1 });
    expect(deps.fetch.calls).toHaveLength(1);
    expect(deps.metrics.get("push.skipped_aborted")).toBe(1);
  });

  test("a receipts run doesn't queue ahead of sends", async () => {
    const { deps, service } = await setup({}, 1);
    const now = deps.clock.now();
    for (let i = 0; i < 900; i++) insertTicket(deps, `t${i}`, VALID_TOKEN(i), now - 20 * MIN);
    const gate = deferred();
    deps.fetch.on("POST", EXPO_RECEIPTS_URL, async () => {
      await gate.promise;
      return { json: { data: {} } };
    });
    okTickets(deps);
    const receipts = service.processReceipts();
    await Bun.sleep(5);
    // The receipts request is stuck, yet a send goes straight through.
    expect(await service.send([msg(VALID_TOKEN("x"))])).toEqual({ sent: 1, failed: 0 });
    gate.resolve();
    await receipts;
  });

  test("bounds the number of concurrent Expo requests", async () => {
    const { deps, service } = await setup({}, 2);
    let active = 0;
    let maxActive = 0;
    const gate = deferred();
    deps.fetch.on("POST", EXPO_SEND_URL, async (call) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active--;
      return {
        json: {
          data: sentBody(call).map((_, i) => ({
            status: "ok",
            id: `${call.body?.length}-${i}-${Math.random()}`,
          })),
        },
      };
    });
    const sending = service.send(Array.from({ length: 500 }, (_, i) => msg(VALID_TOKEN(i), i)));
    await Bun.sleep(5);
    expect(active).toBe(2);
    gate.resolve();
    expect(await sending).toEqual({ sent: 500, failed: 0 });
    expect(maxActive).toBe(2);
  });
});

function insertTicket(deps: TestDeps, id: string, token: string, createdAt: number): void {
  deps.sqlite.run("INSERT INTO push_tickets (ticket_id, push_token, created_at) VALUES (?, ?, ?)", [
    id,
    token,
    createdAt,
  ]);
}

describe("receipts", () => {
  test("checks tickets older than 15 min, deletes processed and expired ones", async () => {
    const { deps, service } = await setup({ EXPO_ACCESS_TOKEN: "expo-secret" });
    const now = deps.clock.now();
    insertTicket(deps, "ok-1", VALID_TOKEN(1), now - RECEIPT_MIN_AGE_MS);
    insertTicket(deps, "err-1", VALID_TOKEN(2), now - 20 * MIN);
    insertTicket(deps, "not-ready", VALID_TOKEN(3), now - 30 * MIN);
    insertTicket(deps, "too-new", VALID_TOKEN(4), now - RECEIPT_MIN_AGE_MS + 1);
    insertTicket(deps, "expired", VALID_TOKEN(5), now - TICKET_MAX_AGE_MS);
    deps.fetch.on("POST", EXPO_RECEIPTS_URL, {
      json: {
        data: {
          "ok-1": { status: "ok" },
          "err-1": { status: "error", message: "rate", details: { error: "MessageRateExceeded" } },
        },
      },
    });

    const result = await service.processReceipts();
    expect(result).toEqual({
      checked: 2,
      ok: 1,
      errors: 1,
      pending: 1,
      expired: 1,
      devicesRemoved: 0,
    });
    const call = deps.fetch.calls[0]!;
    expect(call.url).toBe("https://exp.host/--/api/v2/push/getReceipts");
    expect(call.headers.get("authorization")).toBe("Bearer expo-secret");
    expect((JSON.parse(call.body ?? "{}") as { ids: string[] }).ids.toSorted()).toEqual(
      ["err-1", "not-ready", "ok-1"].toSorted(),
    );
    expect(
      tickets(deps)
        .map((t) => t.ticket_id)
        .toSorted(),
    ).toEqual(["not-ready", "too-new"]);
    expect(deps.metrics.get("push.receipt_error.MessageRateExceeded")).toBe(1);
    expect(deps.metrics.get("push.tickets.pending")).toBe(2);
  });

  test("a DeviceNotRegistered receipt removes the device and prunes orphans", async () => {
    const { deps, service } = await setup();
    const now = deps.clock.now();
    const sql = deps.sqlite;
    const box = secretBoxFromConfig(deps.config);
    const cid = seedCustomer(sql, now);
    const device = seedDevice(sql, cid, VALID_TOKEN("gone"), now - 30 * MIN);
    link(sql, device, seedAccount(sql, box, cid, now));
    insertTicket(deps, "r1", VALID_TOKEN("gone"), now - 20 * MIN);
    deps.fetch.on("POST", EXPO_RECEIPTS_URL, {
      json: {
        data: {
          r1: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        },
      },
    });
    const result = await service.processReceipts();
    expect(result.devicesRemoved).toBe(1);
    expect(count(deps, "devices")).toBe(0);
    expect(count(deps, "reddit_accounts")).toBe(0);
    expect(count(deps, "push_tickets")).toBe(0);
  });

  // A receipt arrives 15 min to 24 h after its ticket. A device that registered
  // again in between (a reinstall can keep the Expo token) is a fresh one.
  test("a late DeviceNotRegistered receipt keeps a device that registered after the push", async () => {
    const { deps, service } = await setup();
    const now = deps.clock.now();
    const sql = deps.sqlite;
    const box = secretBoxFromConfig(deps.config);
    const cid = seedCustomer(sql, now);
    // Pushed at T-20 min, registered again at T-15 min.
    const device = seedDevice(sql, cid, VALID_TOKEN("back"), now - 15 * MIN);
    link(sql, device, seedAccount(sql, box, cid, now));
    insertTicket(deps, "r1", VALID_TOKEN("back"), now - 20 * MIN);
    deps.fetch.on("POST", EXPO_RECEIPTS_URL, {
      json: {
        data: {
          r1: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        },
      },
    });
    const result = await service.processReceipts();
    expect(result.devicesRemoved).toBe(0);
    expect(count(deps, "devices")).toBe(1);
    expect(count(deps, "reddit_accounts")).toBe(1);
    expect(count(deps, "push_tickets")).toBe(0);
  });

  test("requests at most 300 receipt ids at a time", async () => {
    const { deps, service } = await setup();
    const now = deps.clock.now();
    for (let i = 0; i < 650; i++) insertTicket(deps, `t${i}`, VALID_TOKEN(i), now - 20 * MIN);
    deps.fetch.on("POST", EXPO_RECEIPTS_URL, (call) => {
      const { ids } = JSON.parse(call.body ?? "{}") as { ids: string[] };
      return { json: { data: Object.fromEntries(ids.map((id) => [id, { status: "ok" }])) } };
    });
    const result = await service.processReceipts();
    expect(
      deps.fetch.calls.map((c) => (JSON.parse(c.body ?? "{}") as { ids: string[] }).ids.length),
    ).toEqual([300, 300, 50]);
    expect(result.ok).toBe(650);
    expect(count(deps, "push_tickets")).toBe(0);
  });

  test("a failed receipts request keeps its tickets and fails the job", async () => {
    const { deps, service } = await setup();
    const now = deps.clock.now();
    insertTicket(deps, "keep", VALID_TOKEN(1), now - 20 * MIN);
    deps.fetch.on("POST", EXPO_RECEIPTS_URL, { status: 503, body: "unavailable" });
    expect((await rejection(service.processReceipts())).message).toContain("Expo receipt request");
    expect(tickets(deps).map((t) => t.ticket_id)).toEqual(["keep"]);
  });

  test("removeDevice is a no-op for unknown tokens", async () => {
    const { deps, service } = await setup();
    const now = deps.clock.now();
    const box = secretBoxFromConfig(deps.config);
    const cid = seedCustomer(deps.sqlite, now);
    link(
      deps.sqlite,
      seedDevice(deps.sqlite, cid, VALID_TOKEN(1), now),
      seedAccount(deps.sqlite, box, cid, now),
    );
    service.removeDevice(VALID_TOKEN(2));
    expect(count(deps, "devices")).toBe(1);
    expect(count(deps, "reddit_accounts")).toBe(1);
  });

  test("createPushModule registers the 15 min receipts job", async () => {
    const { service } = await setup();
    const registered: { name: string; intervalMs: number }[] = [];
    createPushModule(service).jobs?.({
      every: (name: string, intervalMs: number) => {
        registered.push({ name, intervalMs });
      },
    } as never);
    expect(registered).toEqual([{ name: RECEIPTS_JOB, intervalMs: 15 * MIN }]);
  });
});
