import { afterEach, describe, expect, test } from "bun:test";
import { openConnection } from "../../../src/db/connection";
import {
  createKeyring,
  createSecretBox,
  redditSecretAad,
  secretBoxFromConfig,
} from "../../../src/lib/crypto";
import { RedditError, type RedditErrorKind } from "../../../src/modules/contracts";
import { createPoller, createPollerModule, type Poller } from "../../../src/modules/poller";
import {
  HEARTBEAT_MAX_AGE_MS,
  LAG_ALERT_AFTER_MS,
  LEASE_MS,
  NOTIFIED_RETENTION_MS,
  SESSION_DEAD_MIN_SAMPLES,
  TICK_FAILURES_BEFORE_ALERT,
} from "../../../src/modules/poller/poller";
import { MAX_BACKOFF_MS } from "../../../src/modules/poller/schedule";
import { TEST_KEY, TEST_KEY_2, testDeps, type TestDeps, v1Encrypt } from "../../helpers";
import {
  account,
  deferred,
  fakePush,
  fakeReddit,
  type FakePush,
  type FakeReddit,
  link,
  reply,
  seedAccount,
  seedCustomer,
  seedDevice,
  seedLinked,
  VALID_TOKEN,
} from "../../helpers/poller-push";

const MIN = 60_000;
const byNum = (x: number, y: number): number => x - y;
const HOUR = 60 * MIN;
const INTERVAL = 120_000;
const OFFICIAL = {
  HYDRA_MODE: "official",
  REVENUECAT_PROJECT_ID: "proj",
  REVENUECAT_API_KEY: "key",
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).toReversed()) await fn();
});

interface Setup {
  deps: TestDeps;
  reddit: FakeReddit;
  push: FakePush;
  poller: Poller;
  box: ReturnType<typeof secretBoxFromConfig>;
}

async function setup(
  env: Record<string, string> = {},
  opts: { checkDeadlineMs?: number; tickMs?: number } = {},
): Promise<Setup> {
  const deps = await testDeps({ env });
  const box = secretBoxFromConfig(deps.config);
  const reddit = fakeReddit();
  const push = fakePush();
  const poller = createPoller(deps, {
    reddit,
    push,
    secretBox: box,
    random: () => 0.5,
    ...opts,
  });
  cleanups.push(deps.cleanup);
  cleanups.push(() => poller.stop(100));
  return { deps, reddit, push, poller, box };
}

async function runOnce(s: Setup): Promise<number[]> {
  const ids = s.poller.tick();
  await s.poller.idle();
  return ids;
}

describe("claim", () => {
  test("claims due accounts once and sets a 2 min lease", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const a = seedLinked(s.deps.sqlite, s.box, now).accountId;
    const b = seedLinked(s.deps.sqlite, s.box, now, { nextCheckAt: now - 5_000 }).accountId;
    seedLinked(s.deps.sqlite, s.box, now, { nextCheckAt: now + 1 });

    const claimed = s.poller.claim(10);
    expect(claimed.toSorted(byNum)).toEqual([a, b].toSorted(byNum));
    expect(account(s.deps.sqlite, a).lease_until).toBe(now + LEASE_MS);
    expect(s.poller.claim(10)).toEqual([]);
  });

  test("claims the most overdue first, up to the limit", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    seedLinked(s.deps.sqlite, s.box, now, { nextCheckAt: now - 1_000 });
    const oldest = seedLinked(s.deps.sqlite, s.box, now, { nextCheckAt: now - 9_000 }).accountId;
    expect(s.poller.claim(1)).toEqual([oldest]);
  });

  test("concurrent claims from two connections never overlap", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) ids.push(seedLinked(s.deps.sqlite, s.box, now).accountId);

    const conn2 = openConnection(s.deps.dbPath);
    cleanups.push(() => conn2.close());
    const other = createPoller(
      { ...s.deps, db: conn2.db, sqlite: conn2.sqlite },
      { reddit: s.reddit, push: s.push, secretBox: s.box },
    );
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        Promise.resolve().then(() => (i % 2 === 0 ? s.poller : other).claim(5)),
      ),
    );
    const all = results.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.toSorted((x, y) => x - y)).toEqual(ids.toSorted((x, y) => x - y));
  });

  test("an expired lease is reclaimed", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now).accountId;
    expect(s.poller.claim(5)).toEqual([id]);
    s.deps.clock.advance(LEASE_MS);
    expect(s.poller.claim(5)).toEqual([]);
    s.deps.clock.advance(1);
    expect(s.poller.claim(5)).toEqual([id]);
  });

  test("accounts without a linked device are never claimed", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const cid = seedCustomer(s.deps.sqlite, now);
    seedAccount(s.deps.sqlite, s.box, cid, now);
    expect(s.poller.claim(5)).toEqual([]);
  });

  test("official mode claims only entitled customers", async () => {
    const s = await setup(OFFICIAL);
    const now = s.deps.clock.now();
    const sql = s.deps.sqlite;
    const lifetime = seedLinked(sql, s.box, now, { isPro: true, proExpiresAt: null }).accountId;
    const active = seedLinked(sql, s.box, now, { isPro: true, proExpiresAt: now + HOUR }).accountId;
    seedLinked(sql, s.box, now, { isPro: true, proExpiresAt: now });
    seedLinked(sql, s.box, now, { isPro: false });
    expect(s.poller.claim(10).toSorted(byNum)).toEqual([lifetime, active].toSorted(byNum));
  });

  test("selfhost bypasses the entitlement filter", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const free = seedLinked(s.deps.sqlite, s.box, now, { isPro: false }).accountId;
    const expired = seedLinked(s.deps.sqlite, s.box, now, {
      isPro: true,
      proExpiresAt: now - 1,
    }).accountId;
    expect(s.poller.claim(10).toSorted(byNum)).toEqual([free, expired].toSorted(byNum));
  });
});

describe("checkAccount", () => {
  test("pushes new unread replies after the baseline, once", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now, {
      username: "alice",
      baselineAt: now - 10 * MIN,
      token: VALID_TOKEN("a"),
    }).accountId;
    s.reddit.fallback = () => ({
      replies: [
        reply("t1_new", now - MIN),
        reply("t1_read", now - MIN, { unread: false }),
        reply("t1_old", now - 11 * MIN),
        reply("t1_atbaseline", now - 10 * MIN),
      ],
      unreadCount: 3,
    });

    expect(await runOnce(s)).toEqual([id]);
    expect(s.push.sent).toEqual([
      [
        {
          to: VALID_TOKEN("a"),
          title: "someone in Post t1_new",
          body: "body t1_new",
          badge: 3,
          sound: "default",
          data: { type: "inbox", username: "alice", itemId: "t1_new" },
        },
      ],
    ]);
    const notified = s.deps.sqlite
      .query<{ item_id: string }, [number]>(
        "SELECT item_id FROM notified_items WHERE account_id = ?",
      )
      .all(id);
    expect(notified.map((r) => r.item_id)).toEqual(["t1_new"]);

    // The same inbox on the next check pushes nothing.
    s.deps.clock.advance(INTERVAL);
    expect(await runOnce(s)).toEqual([id]);
    expect(s.push.sent).toHaveLength(1);

    // A new reply is pushed; the old one is not repeated.
    s.reddit.fallback = () => ({
      replies: [reply("t1_newer", s.deps.clock.now() - 1), reply("t1_new", now - MIN)],
    });
    s.deps.clock.advance(INTERVAL);
    await runOnce(s);
    expect(s.push.sent).toHaveLength(2);
    expect(s.push.sent[1]?.map((m) => m.data?.["itemId"])).toEqual(["t1_newer"]);
    expect(s.deps.metrics.get("poller.pushes.sent")).toBe(2);
  });

  test("replies older than the notified_items retention are never pushed", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    seedLinked(s.deps.sqlite, s.box, now, { baselineAt: now - 60 * 24 * HOUR });
    s.reddit.fallback = () => ({ replies: [reply("t1_ancient", now - NOTIFIED_RETENTION_MS)] });
    await runOnce(s);
    expect(s.push.sent).toEqual([]);
  });

  test("fans out every reply to every linked device", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const sql = s.deps.sqlite;
    const cid = seedCustomer(sql, now);
    const d1 = seedDevice(sql, cid, VALID_TOKEN(1), now);
    const d2 = seedDevice(sql, cid, VALID_TOKEN(2), now);
    const other = seedDevice(sql, cid, VALID_TOKEN(3), now);
    const id = seedAccount(sql, s.box, cid, now, { username: "bob" });
    const otherAccount = seedAccount(sql, s.box, cid, now, { nextCheckAt: now + HOUR });
    link(sql, d1, id);
    link(sql, d2, id);
    link(sql, other, otherAccount);
    s.reddit.fallback = () => ({
      replies: [reply("t1_a", now - 1), reply("t1_b", now - 2)],
      unreadCount: 5,
    });

    await runOnce(s);
    const messages = s.push.sent.flat();
    expect(messages.map((m) => [m.to, m.data?.["itemId"]])).toEqual([
      [VALID_TOKEN(1), "t1_a"],
      [VALID_TOKEN(2), "t1_a"],
      [VALID_TOKEN(1), "t1_b"],
      [VALID_TOKEN(2), "t1_b"],
    ]);
    expect(messages.every((m) => m.badge === 5 && m.sound === "default")).toBe(true);
  });

  test("success schedules the next check and resets the counters", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now, {
      consecutiveFailures: 3,
      sessionFailures: 1,
      status: "needs_reauth",
    }).accountId;
    await runOnce(s);
    expect(account(s.deps.sqlite, id)).toMatchObject({
      next_check_at: now + INTERVAL,
      consecutive_failures: 0,
      session_failures: 0,
      status: "active",
      last_success_at: now,
      lease_until: null,
    });
    expect(s.deps.metrics.get("poller.checks")).toBe(1);
    expect(s.deps.metrics.get("poller.success")).toBe(1);
  });

  test("persists the token, renewed session and persona encrypted with the account AAD", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const { accountId: id, customerRowId } = seedLinked(s.deps.sqlite, s.box, now, {
      username: "carol",
      session: "old-session",
    });
    s.reddit.fallback = () => ({
      token: { value: "jwt-2", expiresAt: now + HOUR },
      renewedSession: "new-session",
      persona: { proxyKey: "px-7", userAgent: "UA/7" },
    });
    await runOnce(s);
    const row = account(s.deps.sqlite, id);
    const aad = redditSecretAad(customerRowId, "carol");
    expect(s.box.decryptSecret(row.session_enc, aad)).toBe("new-session");
    expect(row.token_enc?.startsWith("v2:")).toBe(true);
    expect(s.box.decryptSecret(row.token_enc ?? "", aad)).toBe("jwt-2");
    expect(row.token_expires_at).toBe(now + HOUR);
    expect(row).toMatchObject({ proxy_key: "px-7", user_agent: "UA/7" });

    // The next check gets the persisted credentials back.
    s.deps.clock.advance(INTERVAL);
    await runOnce(s);
    expect(s.reddit.calls[1]).toMatchObject({
      accountId: id,
      username: "carol",
      session: "new-session",
      token: { value: "jwt-2", expiresAt: now + HOUR },
      persona: { proxyKey: "px-7", userAgent: "UA/7" },
    });
  });

  // While every query fails (a rotated persisted-query hash), the token must
  // survive the failure, or each check would repeat the handshake.
  test("a failed fetch's token and renewed session are persisted", async () => {
    const s = await setup();
    const sql = s.deps.sqlite;
    const now = s.deps.clock.now();
    const ORIGINAL = '{"name":"reddit_session","value":"abc"}';
    const RENEWED = '{"name":"reddit_session","value":"abc-renewed"}';
    const { accountId: id, customerRowId } = seedLinked(sql, s.box, now, {
      username: "carol",
      session: ORIGINAL,
    });
    s.reddit.fallback = () => {
      const err = new RedditError("graphql_error", "PersistedQueryNotFound");
      err.unused = { token: { value: "jwt-kept", expiresAt: now + HOUR }, renewedSession: RENEWED };
      throw err;
    };
    expect((await s.poller.checkAccount(id)).status).toBe("failure");
    const row = account(sql, id);
    const aad = redditSecretAad(customerRowId, "carol");
    expect(s.box.decryptSecret(row.token_enc ?? "", aad)).toBe("jwt-kept");
    expect(row.token_expires_at).toBe(now + HOUR);
    expect(s.box.decryptSecret(row.session_enc, aad)).toBe(RENEWED);
    expect(row.consecutive_failures).toBe(1);

    // A null token (rejected, or a dead session) keeps the stored one.
    s.deps.clock.advance(HOUR);
    s.reddit.fallback = () => {
      const err = new RedditError("session_dead", "dead");
      err.unused = { token: null, renewedSession: null };
      throw err;
    };
    await s.poller.checkAccount(id);
    expect(s.reddit.calls[1]).toMatchObject({
      session: RENEWED,
      token: { value: "jwt-kept", expiresAt: now + HOUR },
    });
    expect(s.box.decryptSecret(account(sql, id).token_enc ?? "", aad)).toBe("jwt-kept");
  });

  test("a failed fetch's credentials are dropped when registration replaced the session", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const { accountId: id, customerRowId } = seedLinked(s.deps.sqlite, s.box, now, {
      username: "erin",
    });
    const aad = redditSecretAad(customerRowId, "erin");
    s.reddit.fallback = () => {
      s.deps.sqlite.run(
        "UPDATE reddit_accounts SET session_enc = ?, token_enc = NULL WHERE id = ?",
        [s.box.encryptSecret("registered", aad), id],
      );
      const err = new RedditError("server", "502");
      err.unused = { token: { value: "old-jwt", expiresAt: now + HOUR }, renewedSession: "x" };
      throw err;
    };
    expect((await s.poller.checkAccount(id)).status).toBe("superseded");
    const row = account(s.deps.sqlite, id);
    expect(s.box.decryptSecret(row.session_enc, aad)).toBe("registered");
    expect(row.token_enc).toBeNull();
  });

  test("a v1 session is re-encrypted to v2, even when the check then fails", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const cid = seedCustomer(s.deps.sqlite, now);
    const device = seedDevice(s.deps.sqlite, cid, VALID_TOKEN("v1"), now);
    const id = seedAccount(s.deps.sqlite, s.box, cid, now, {
      username: "dave",
      sessionEnc: v1Encrypt("legacy-session", TEST_KEY),
    });
    link(s.deps.sqlite, device, id);
    s.reddit.fallback = () => {
      throw new RedditError("server", "500");
    };
    await runOnce(s);
    const row = account(s.deps.sqlite, id);
    expect(row.session_enc.startsWith("v2:")).toBe(true);
    expect(s.box.decryptSecret(row.session_enc, redditSecretAad(cid, "dave"))).toBe(
      "legacy-session",
    );
    expect(s.reddit.calls[0]?.session).toBe("legacy-session");
    expect(s.deps.metrics.get("poller.session_reencrypted")).toBe(1);
  });

  test("a session under a previous key is re-encrypted with the current key", async () => {
    const s = await setup({ ENCRYPTION_KEYS_PREVIOUS: TEST_KEY_2 });
    const now = s.deps.clock.now();
    const cid = seedCustomer(s.deps.sqlite, now);
    const device = seedDevice(s.deps.sqlite, cid, VALID_TOKEN("rot"), now);
    const aad = redditSecretAad(cid, "frank");
    const oldBox = createSecretBox(createKeyring(TEST_KEY_2));
    const id = seedAccount(s.deps.sqlite, s.box, cid, now, {
      username: "frank",
      sessionEnc: oldBox.encryptSecret("rotated-session", aad),
    });
    link(s.deps.sqlite, device, id);
    s.reddit.fallback = () => {
      throw new RedditError("server", "500");
    };
    await runOnce(s);
    const row = account(s.deps.sqlite, id);
    expect(row.session_enc.split(":")[1]).toBe(s.box.keyring.current.id);
    expect(s.box.needsReencrypt(row.session_enc)).toBe(false);
    expect(s.box.decryptSecret(row.session_enc, aad)).toBe("rotated-session");
    expect(s.deps.metrics.get("poller.session_reencrypted")).toBe(1);
  });

  test("a session replaced by registration mid-check is not overwritten", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const { accountId: id, customerRowId } = seedLinked(s.deps.sqlite, s.box, now, {
      username: "erin",
    });
    const aad = redditSecretAad(customerRowId, "erin");
    s.reddit.fallback = () => {
      s.deps.sqlite.run(
        "UPDATE reddit_accounts SET session_enc = ?, token_enc = NULL WHERE id = ?",
        [s.box.encryptSecret("registered", aad), id],
      );
      return { renewedSession: "renewed-old", token: { value: "old-jwt", expiresAt: now + HOUR } };
    };
    await runOnce(s);
    const row = account(s.deps.sqlite, id);
    expect(s.box.decryptSecret(row.session_enc, aad)).toBe("registered");
    expect(row.token_enc).toBeNull();
  });

  test("an account deleted mid-check is left alone", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now).accountId;
    s.reddit.fallback = () => {
      s.deps.sqlite.run("DELETE FROM reddit_accounts WHERE id = ?", [id]);
      return { replies: [reply("t1_x", now - 1)] };
    };
    s.poller.claim(1);
    expect(await s.poller.checkAccount(id)).toEqual({ status: "gone" });
    expect(s.push.sent).toEqual([]);
  });
});

describe("failure scheduling", () => {
  const transient: RedditErrorKind[] = [
    "auth",
    "edge_block",
    "rate_limited",
    "server",
    "graphql_error",
    "network",
    "no_proxy",
  ];

  for (const kind of transient) {
    test(`${kind} backs off exponentially up to 30 min`, async () => {
      const s = await setup();
      const now = s.deps.clock.now();
      const id = seedLinked(s.deps.sqlite, s.box, now).accountId;
      s.reddit.fallback = () => {
        throw new RedditError(kind, `boom ${kind}`);
      };
      await runOnce(s);
      let row = account(s.deps.sqlite, id);
      expect(row).toMatchObject({
        consecutive_failures: 1,
        session_failures: 0,
        status: "active",
        next_check_at: now + INTERVAL,
        last_error: `${kind}: boom ${kind}`,
        last_error_at: now,
        lease_until: null,
      });
      expect(s.deps.metrics.get(`poller.failure.${kind}`)).toBe(1);

      s.deps.clock.set(row.next_check_at);
      await runOnce(s);
      row = account(s.deps.sqlite, id);
      expect(row.consecutive_failures).toBe(2);
      expect(row.next_check_at).toBe(s.deps.clock.now() + 2 * INTERVAL);

      s.deps.sqlite.run("UPDATE reddit_accounts SET consecutive_failures = 9 WHERE id = ?", [id]);
      s.deps.clock.set(row.next_check_at);
      await runOnce(s);
      expect(account(s.deps.sqlite, id).next_check_at).toBe(s.deps.clock.now() + MAX_BACKOFF_MS);
    });
  }

  test("session_dead retries in 2–5 min, then needs_reauth for 11–12 h on the second", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now, { proxyKey: "px-1" }).accountId;
    s.reddit.fallback = () => {
      throw new RedditError("session_dead", "no inbox");
    };
    await runOnce(s);
    let row = account(s.deps.sqlite, id);
    expect(row).toMatchObject({
      session_failures: 1,
      status: "active",
      next_check_at: now + 3.5 * MIN,
    });

    s.deps.clock.set(row.next_check_at);
    await runOnce(s);
    // The retry asks the client to avoid the proxy that saw the failure.
    expect(s.reddit.calls[1]).toMatchObject({ avoidProxyKey: "px-1" });
    row = account(s.deps.sqlite, id);
    expect(row).toMatchObject({
      session_failures: 2,
      status: "needs_reauth",
      next_check_at: s.deps.clock.now() + 11.5 * HOUR,
    });
    expect(s.deps.metrics.get("poller.needs_reauth")).toBe(1);
    expect(s.deps.metrics.get("poller.failure.session_dead")).toBe(2);

    // Still polled at the v1 cadence; a working session makes it active again.
    s.reddit.fallback = () => ({});
    s.deps.clock.set(row.next_check_at);
    await runOnce(s);
    expect(account(s.deps.sqlite, id)).toMatchObject({ status: "active", session_failures: 0 });
  });

  test("a transient failure between two session_dead failures doesn't reset the count", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now, { sessionFailures: 1 }).accountId;
    s.reddit.fallback = () => {
      throw new RedditError("network", "reset");
    };
    await runOnce(s);
    expect(account(s.deps.sqlite, id).session_failures).toBe(1);
    s.reddit.fallback = () => {
      throw new RedditError("session_dead", "dead");
    };
    s.deps.clock.set(account(s.deps.sqlite, id).next_check_at);
    await runOnce(s);
    expect(account(s.deps.sqlite, id).status).toBe("needs_reauth");
  });

  test("the 60 s deadline turns a hung fetch into a timeout failure", async () => {
    const s = await setup({}, { checkDeadlineMs: 20 });
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now).accountId;
    s.reddit.fallback = () => new Promise(() => {});
    await runOnce(s);
    expect(account(s.deps.sqlite, id)).toMatchObject({
      consecutive_failures: 1,
      last_error: "timeout: check deadline exceeded",
    });
    expect(s.deps.metrics.get("poller.failure.timeout")).toBe(1);
  });

  test("an unexpected error is an internal failure", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now).accountId;
    s.reddit.fallback = () => {
      throw new TypeError("bug");
    };
    await runOnce(s);
    expect(account(s.deps.sqlite, id)).toMatchObject({
      consecutive_failures: 1,
      last_error: "internal: bug",
    });
  });

  test("an undecryptable session marks the account needs_reauth and alerts", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now, { sessionEnc: "v2:deadbeef:x:y:z" }).accountId;
    await runOnce(s);
    expect(s.reddit.calls).toEqual([]);
    expect(account(s.deps.sqlite, id)).toMatchObject({ status: "needs_reauth" });
    expect(s.deps.alerter.alerts.map((a) => a.key)).toEqual(["poller:decrypt-failed"]);
  });

  test("a high failure rate alerts", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    for (let i = 0; i < 25; i++) seedLinked(s.deps.sqlite, s.box, now);
    s.reddit.fallback = () => {
      throw new RedditError("graphql_error", "PersistedQueryNotFound");
    };
    await runOnce(s);
    const alert = s.deps.alerter.alerts.find((a) => a.key === "poller:failure-rate");
    expect(alert?.message).toContain("graphql_error=");
    expect(alert?.message).toContain("persisted query hash");
  });
});

describe("loop", () => {
  test("never runs more than POLL_CONCURRENCY checks at once", async () => {
    const s = await setup({ POLL_CONCURRENCY: "3" });
    const now = s.deps.clock.now();
    for (let i = 0; i < 7; i++) seedLinked(s.deps.sqlite, s.box, now);
    const gates = new Map<number, ReturnType<typeof deferred<void>>>();
    let active = 0;
    let maxActive = 0;
    s.reddit.fallback = async (creds) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const gate = deferred();
      gates.set(creds.accountId, gate);
      await gate.promise;
      active--;
      return {};
    };
    const first = s.poller.tick();
    expect(first).toHaveLength(3);
    expect(s.poller.inFlight).toBe(3);
    expect(s.deps.metrics.get("poller.inflight")).toBe(3);
    expect(s.poller.tick()).toEqual([]);

    await Promise.resolve();
    gates.get(first[0] ?? -1)?.resolve();
    while (s.poller.inFlight === 3) await Bun.sleep(1);
    expect(s.poller.tick()).toHaveLength(1);

    while (gates.size < 7 || s.poller.inFlight > 0) {
      for (const g of gates.values()) g.resolve();
      await Bun.sleep(1);
      s.poller.tick();
    }
    expect(maxActive).toBe(3);
    expect(s.deps.metrics.get("poller.success")).toBe(7);
  });

  test("records the queue lag", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    seedLinked(s.deps.sqlite, s.box, now, { nextCheckAt: now - 4_000 });
    await runOnce(s);
    expect(s.deps.metrics.get("poller.lag_ms")).toBe(4_000);
  });

  test("start runs the loop; stop releases the leases of hung checks", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const hung = seedLinked(s.deps.sqlite, s.box, now).accountId;
    let signal: AbortSignal | undefined;
    s.reddit.fallback = (_creds, sig) => {
      signal = sig;
      return new Promise(() => {});
    };
    s.poller.start();
    while (s.poller.inFlight === 0) await Bun.sleep(1);
    expect(account(s.deps.sqlite, hung).lease_until).toBe(now + LEASE_MS);
    expect(s.poller.health().ok).toBe(true);

    await s.poller.stop(20);
    expect(s.poller.running).toBe(false);
    expect(signal?.aborted).toBe(true);
    const row = account(s.deps.sqlite, hung);
    expect(row).toMatchObject({ lease_until: null, consecutive_failures: 0, last_error: null });
    await s.poller.idle();
    // Nothing is written after the abandon.
    expect(account(s.deps.sqlite, hung)).toEqual(row);
    // Stopped: no more claims.
    expect(s.poller.tick()).toEqual([]);
  });

  test("stop waits for checks that finish in time", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now).accountId;
    const gate = deferred();
    s.reddit.fallback = async () => {
      await gate.promise;
      return {};
    };
    s.poller.tick();
    const stopping = s.poller.stop(5_000);
    gate.resolve();
    await stopping;
    expect(account(s.deps.sqlite, id)).toMatchObject({
      lease_until: null,
      next_check_at: now + INTERVAL,
    });
  });

  // Claims used to happen only once per tick, which capped throughput at
  // POLL_CONCURRENCY checks per second however fast Reddit answered.
  test("a finished check claims a replacement without waiting for the next tick", async () => {
    const s = await setup({ POLL_CONCURRENCY: "1" }, { tickMs: 60_000 });
    const now = s.deps.clock.now();
    for (let i = 0; i < 4; i++) seedLinked(s.deps.sqlite, s.box, now);
    s.poller.start();
    // One tick (the first runs right away); the next is a minute out.
    for (let i = 0; i < 200 && s.deps.metrics.get("poller.success") < 4; i++) await Bun.sleep(1);
    expect(s.deps.metrics.get("poller.success")).toBe(4);
    expect(s.reddit.calls).toHaveLength(4);
  });

  test("an in-flight check is tracked per launch, not per account id", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now).accountId;
    const gates: ReturnType<typeof deferred<void>>[] = [];
    s.reddit.fallback = async () => {
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return {};
    };
    expect(s.poller.tick()).toEqual([id]);
    // The first check outlives its lease, so the account is claimed again.
    s.deps.clock.advance(LEASE_MS + 1);
    expect(s.poller.tick()).toEqual([id]);
    expect(s.poller.inFlight).toBe(2);
    while (gates.length < 2) await Bun.sleep(1);
    gates[0]!.resolve();
    while (s.poller.inFlight > 1) await Bun.sleep(1);
    // The old check's cleanup didn't drop the new one.
    expect(s.poller.inFlight).toBe(1);
    gates[1]!.resolve();
    await s.poller.idle();
    expect(s.poller.inFlight).toBe(0);
  });

  test("alerts poller:lag when due accounts wait over one interval for 5 min", async () => {
    const s = await setup({ POLL_CONCURRENCY: "1" });
    const now = s.deps.clock.now();
    seedLinked(s.deps.sqlite, s.box, now, { nextCheckAt: now - 10 * MIN });
    seedLinked(s.deps.sqlite, s.box, now, { nextCheckAt: now - 10 * MIN });
    const gate = deferred();
    s.reddit.fallback = async () => {
      await gate.promise;
      return {};
    };
    s.poller.tick();
    expect(s.deps.alerter.alerts).toEqual([]);
    s.deps.clock.advance(LAG_ALERT_AFTER_MS - 1);
    s.poller.tick();
    expect(s.deps.alerter.alerts).toEqual([]);
    s.deps.clock.advance(1);
    s.poller.tick();
    expect(s.deps.alerter.alerts.map((a) => a.key)).toEqual(["poller:lag"]);
    gate.resolve();
    await s.poller.idle();
  });

  // A tick that keeps failing (disk full, a damaged table...) stops all
  // polling and fails /healthz; it used to only log.
  test("alerts poller:stalled after consecutive tick failures", async () => {
    const s = await setup({}, { tickMs: 1 });
    s.deps.sqlite.run("ALTER TABLE device_accounts RENAME TO device_accounts_broken");
    s.poller.start();
    for (let i = 0; i < 500 && s.deps.alerter.alerts.length === 0; i++) await Bun.sleep(1);
    expect(s.deps.alerter.alerts.map((a) => a.key)).toEqual(["poller:stalled"]);
    expect(s.deps.metrics.get("poller.tick_errors")).toBeGreaterThanOrEqual(
      TICK_FAILURES_BEFORE_ALERT,
    );
    expect(s.poller.health().detail).toMatchObject({
      consecutiveTickFailures: expect.any(Number),
    });
    await s.poller.stop();
    s.deps.sqlite.run("ALTER TABLE device_accounts_broken RENAME TO device_accounts");
  });

  test("health fails when the heartbeat is older than 30 s while running", async () => {
    const s = await setup();
    expect(s.poller.health().ok).toBe(true);
    s.poller.start();
    await Bun.sleep(5);
    expect(s.poller.health().ok).toBe(true);
    s.deps.clock.advance(HEARTBEAT_MAX_AGE_MS + 1);
    expect(s.poller.health().ok).toBe(false);
    await s.poller.stop();
    expect(s.poller.health().ok).toBe(true);
  });
});

describe("who gets the push", () => {
  const SESSION = '{"name":"reddit_session","value":"abc"}';

  // Two phones of one customer logged in separately (different cookies): the
  // account is polled with whichever session registered last, and every linked
  // device gets the push.
  test("every device linked to the account receives it", async () => {
    const s = await setup();
    const sql = s.deps.sqlite;
    const now = s.deps.clock.now();
    const owner = seedLinked(sql, s.box, now, { session: SESSION, token: VALID_TOKEN("phone") });
    const tablet = seedDevice(sql, owner.customerRowId, VALID_TOKEN("tablet"), now);
    link(sql, tablet, owner.accountId);
    s.reddit.fallback = () => ({ replies: [reply("t1_reply", now - 1)] });

    expect((await s.poller.checkAccount(owner.accountId)).status).toBe("success");
    expect(s.push.sent.flat().map((m) => m.to)).toEqual([
      VALID_TOKEN("phone"),
      VALID_TOKEN("tablet"),
    ]);
  });

  test("a session Reddit renewed keeps its devices", async () => {
    const s = await setup();
    const sql = s.deps.sqlite;
    const now = s.deps.clock.now();
    const RENEWED = '{"name":"reddit_session","value":"abc-renewed"}';
    const a = seedLinked(sql, s.box, now, { session: SESSION, token: VALID_TOKEN("phone") });
    s.reddit.fallback = () => ({
      replies: [reply("t1_first", now - 1)],
      renewedSession: RENEWED,
    });
    await s.poller.checkAccount(a.accountId);
    expect(s.push.sent.flat().map((m) => m.to)).toEqual([VALID_TOKEN("phone")]);

    // The next check polls with the renewed session and still reaches the phone.
    s.deps.clock.advance(5 * MIN);
    s.reddit.fallback = () => ({ replies: [reply("t1_second", s.deps.clock.now() - 1)] });
    await s.poller.checkAccount(a.accountId);
    expect(s.push.sent.flat().map((m) => m.to)).toEqual([
      VALID_TOKEN("phone"),
      VALID_TOKEN("phone"),
    ]);
  });

  test("the check's deadline signal goes to the push service", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const a = seedLinked(s.deps.sqlite, s.box, now);
    s.reddit.fallback = () => ({ replies: [reply("t1_x", now - 1)] });
    await s.poller.checkAccount(a.accountId);
    expect(s.push.options[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

/** Runs `live` successful, then `dead` session_dead checks, each on a fresh account. */
async function checks(s: Setup, live: number, dead: number) {
  const now = s.deps.clock.now();
  const ids: number[] = [];
  for (let i = 0; i < live + dead; i++) ids.push(seedLinked(s.deps.sqlite, s.box, now).accountId);
  const deadIds = new Set(ids.slice(live));
  s.reddit.fallback = (creds) => {
    if (deadIds.has(creds.accountId)) throw new RedditError("session_dead", "dead");
    return {};
  };
  for (const id of ids) await s.poller.checkAccount(id);
}

describe("dead-session alert", () => {
  // session_dead is left out of the failure-rate alert, so a Reddit incident
  // that makes every session look dead used to put every account in
  // needs_reauth for 11-12 h without a word.
  test("alerts when session_dead is a large share of recent checks", async () => {
    const s = await setup();
    await checks(s, SESSION_DEAD_MIN_SAMPLES - 10, 10);
    expect(s.deps.alerter.alerts.map((a) => a.key)).toEqual(["poller:session-dead-rate"]);
  });

  test("an ordinary trickle of expired sessions doesn't alert", async () => {
    const s = await setup();
    await checks(s, SESSION_DEAD_MIN_SAMPLES - 5, 5);
    expect(s.deps.alerter.alerts).toEqual([]);
  });
});

describe("module", () => {
  test("prunes notified items older than 30 days", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now).accountId;
    const insert = s.deps.sqlite.query(
      "INSERT INTO notified_items (account_id, item_id, notified_at) VALUES (?, ?, ?)",
    );
    insert.run(id, "old", now - NOTIFIED_RETENTION_MS - 1);
    insert.run(id, "keep", now - NOTIFIED_RETENTION_MS + 1);
    expect(s.poller.pruneNotifiedItems()).toBe(1);
    const left = s.deps.sqlite
      .query<{ item_id: string }, []>("SELECT item_id FROM notified_items")
      .all();
    expect(left.map((r) => r.item_id)).toEqual(["keep"]);
  });

  test("createPollerModule wires start, stop, health and the prune job", async () => {
    const s = await setup();
    const module = createPollerModule(s.poller);
    expect(module.name).toBe("poller");
    const jobs: string[] = [];
    module.jobs?.({
      every: (name: string) => {
        jobs.push(name);
      },
    } as never);
    expect(jobs).toEqual(["poller-prune-notified"]);
    await module.start?.();
    expect(s.poller.running).toBe(true);
    expect(module.health?.().ok).toBe(true);
    await module.stop?.();
    expect(s.poller.running).toBe(false);
  });
});

describe("late results after the account changed mid-check", () => {
  test("a deleted account's id is never handed to a new account (AUTOINCREMENT)", async () => {
    const s = await setup();
    const sql = s.deps.sqlite;
    const now = s.deps.clock.now();
    const alice = seedLinked(sql, s.box, now, { username: "alice" });
    sql.run("DELETE FROM devices WHERE id = ?", [alice.deviceId]);
    sql.run("DELETE FROM reddit_accounts WHERE id = ?", [alice.accountId]);
    const bob = seedLinked(sql, s.box, now, { username: "bob" });
    expect(bob.accountId).toBeGreaterThan(alice.accountId);
  });

  test("a session_dead on a session replaced by registration leaves the new session alone", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const { accountId: id, customerRowId } = seedLinked(s.deps.sqlite, s.box, now, {
      username: "erin",
      sessionFailures: 1,
      consecutiveFailures: 1,
      nextCheckAt: now,
    });
    const aad = redditSecretAad(customerRowId, "erin");
    s.reddit.fallback = () => {
      // What registration does when the app sends a new session.
      s.deps.sqlite.run(
        `UPDATE reddit_accounts
         SET session_enc = ?, token_enc = NULL, token_expires_at = NULL, session_failures = 0,
             status = 'active', next_check_at = MIN(next_check_at, ?)
         WHERE id = ?`,
        [s.box.encryptSecret("new-session", aad), s.deps.clock.now(), id],
      );
      throw new RedditError("session_dead", "old session is dead");
    };
    s.poller.claim(1);
    expect(await s.poller.checkAccount(id)).toEqual({
      status: "superseded",
      kind: "session_dead",
      message: "old session is dead",
    });
    expect(account(s.deps.sqlite, id)).toMatchObject({
      status: "active",
      session_failures: 0,
      consecutive_failures: 1,
      next_check_at: now,
      lease_until: null,
      last_error: "session_dead: old session is dead",
      last_error_at: now,
    });
    expect(s.deps.metrics.get("poller.needs_reauth")).toBe(0);
    expect(s.deps.metrics.get("poller.superseded")).toBe(1);

    // The very next tick checks the new session.
    s.reddit.fallback = () => ({});
    expect(await runOnce(s)).toEqual([id]);
    expect(s.reddit.calls.at(-1)?.session).toBe("new-session");
    expect(account(s.deps.sqlite, id)).toMatchObject({ status: "active", session_failures: 0 });
  });

  test("failure counters come from the row as it is now, not as it was at check start", async () => {
    const s = await setup();
    const now = s.deps.clock.now();
    const id = seedLinked(s.deps.sqlite, s.box, now, {
      status: "needs_reauth",
      sessionFailures: 2,
    }).accountId;
    s.reddit.fallback = () => {
      // Registration reactivates the account with the same session.
      s.deps.sqlite.run(
        "UPDATE reddit_accounts SET status = 'active', session_failures = 0 WHERE id = ?",
        [id],
      );
      throw new RedditError("session_dead", "dead");
    };
    s.poller.claim(1);
    expect(await s.poller.checkAccount(id)).toMatchObject({
      status: "failure",
      kind: "session_dead",
      needsReauth: false,
    });
    expect(account(s.deps.sqlite, id)).toMatchObject({
      status: "active",
      session_failures: 1,
      next_check_at: now + 3.5 * MIN,
    });
  });
});
