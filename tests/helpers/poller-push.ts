/** Fixtures for the poller and push tests: seeding rows, a fake RedditClient and a fake PushService. */
import type { Database } from "bun:sqlite";
import { redditSecretAad, type SecretBox } from "../../src/lib/crypto";
import type {
  InboxReply,
  InboxResult,
  PushMessage,
  PushSendResult,
  PushSendOptions,
  PushService,
  RedditClient,
  RedditCredentials,
} from "../../src/modules/contracts";

export const VALID_TOKEN = (n: number | string): string => `ExponentPushToken[device-${n}]`;

export function seedCustomer(
  sqlite: Database,
  now: number,
  opts: { customerId?: string; isPro?: boolean; proExpiresAt?: number | null } = {},
): number {
  const row = sqlite
    .query<{ id: number }, { cid: string; pro: number; exp: number | null; now: number }>(
      `INSERT INTO customers (customer_id, is_pro, pro_expires_at, created_at, updated_at)
       VALUES ($cid, $pro, $exp, $now, $now) RETURNING id`,
    )
    .get({
      cid: opts.customerId ?? `cust-${Math.random().toString(36).slice(2)}`,
      pro: opts.isPro === false ? 0 : 1,
      exp: opts.proExpiresAt ?? null,
      now,
    });
  if (!row) throw new Error("customer insert failed");
  return row.id;
}

export function seedDevice(sqlite: Database, customerRowId: number, token: string, now: number) {
  const row = sqlite
    .query<{ id: number }, { token: string; cid: number; now: number }>(
      `INSERT INTO devices (push_token, customer_id, last_registered_at, created_at)
       VALUES ($token, $cid, $now, $now) RETURNING id`,
    )
    .get({ token, cid: customerRowId, now });
  if (!row) throw new Error("device insert failed");
  return row.id;
}

export interface SeedAccountOptions {
  username?: string;
  session?: string;
  /** Overrides the encrypted session blob (for v1 blobs). */
  sessionEnc?: string;
  nextCheckAt?: number;
  baselineAt?: number;
  leaseUntil?: number | null;
  consecutiveFailures?: number;
  sessionFailures?: number;
  status?: "active" | "needs_reauth";
  proxyKey?: string | null;
  userAgent?: string | null;
}

export function seedAccount(
  sqlite: Database,
  box: SecretBox,
  customerRowId: number,
  now: number,
  opts: SeedAccountOptions = {},
): number {
  const username = opts.username ?? `user${Math.random().toString(36).slice(2, 8)}`;
  const session = opts.session ?? '{"name":"reddit_session","value":"abc"}';
  const sessionEnc =
    opts.sessionEnc ?? box.encryptSecret(session, redditSecretAad(customerRowId, username));
  const row = sqlite
    .query<{ id: number }, Record<string, string | number | null>>(
      `INSERT INTO reddit_accounts
         (customer_id, username, session_enc, status, next_check_at, lease_until,
          consecutive_failures, session_failures, baseline_at, proxy_key, user_agent,
          created_at, updated_at)
       VALUES ($cid, $username, $sessionEnc, $status, $next, $lease, $cf, $sf, $baseline,
               $proxyKey, $ua, $now, $now)
       RETURNING id`,
    )
    .get({
      cid: customerRowId,
      username,
      sessionEnc,
      status: opts.status ?? "active",
      next: opts.nextCheckAt ?? now,
      lease: opts.leaseUntil ?? null,
      cf: opts.consecutiveFailures ?? 0,
      sf: opts.sessionFailures ?? 0,
      baseline: opts.baselineAt ?? now - 60 * 60_000,
      proxyKey: opts.proxyKey ?? null,
      ua: opts.userAgent ?? null,
      now,
    });
  if (!row) throw new Error("account insert failed");
  return row.id;
}

/** Links a device to an account. */
export function link(sqlite: Database, deviceId: number, accountId: number): void {
  sqlite.run("INSERT INTO device_accounts (device_id, account_id) VALUES (?, ?)", [
    deviceId,
    accountId,
  ]);
}

/** A customer with one device and one linked account. */
export function seedLinked(
  sqlite: Database,
  box: SecretBox,
  now: number,
  opts: SeedAccountOptions & { isPro?: boolean; proExpiresAt?: number | null; token?: string } = {},
) {
  const customerRowId = seedCustomer(sqlite, now, opts);
  const deviceId = seedDevice(sqlite, customerRowId, opts.token ?? VALID_TOKEN(customerRowId), now);
  const accountId = seedAccount(sqlite, box, customerRowId, now, opts);
  link(sqlite, deviceId, accountId);
  return { customerRowId, deviceId, accountId };
}

export interface AccountState {
  id: number;
  customer_id: number;
  username: string;
  session_enc: string;
  token_enc: string | null;
  token_expires_at: number | null;
  status: string;
  next_check_at: number;
  lease_until: number | null;
  consecutive_failures: number;
  session_failures: number;
  last_success_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  baseline_at: number;
  proxy_key: string | null;
  user_agent: string | null;
}

export function account(sqlite: Database, id: number): AccountState {
  const row = sqlite
    .query<AccountState, [number]>("SELECT * FROM reddit_accounts WHERE id = ?")
    .get(id);
  if (!row) throw new Error(`account ${id} not found`);
  return row;
}

export function reply(itemId: string, sentAt: number, overrides: Partial<InboxReply> = {}) {
  return {
    itemId,
    unread: true,
    sentAt,
    title: `someone in Post ${itemId}`,
    body: `body ${itemId}`,
    ...overrides,
  } satisfies InboxReply;
}

export type InboxResponder = (
  creds: RedditCredentials,
  signal: AbortSignal,
) => Partial<InboxResult> | Promise<Partial<InboxResult>>;

export interface FakeReddit extends RedditClient {
  calls: RedditCredentials[];
  /** Per account id; falls back to `fallback`. */
  responders: Map<number, InboxResponder>;
  fallback: InboxResponder;
}

export function fakeReddit(fallback: InboxResponder = () => ({})): FakeReddit {
  const fake: FakeReddit = {
    calls: [],
    responders: new Map(),
    fallback,
    async fetchInbox(creds, signal) {
      fake.calls.push(creds);
      const responder = fake.responders.get(creds.accountId) ?? fake.fallback;
      const partial = await responder(creds, signal);
      const replies = partial.replies ?? [];
      return {
        replies,
        unreadCount: partial.unreadCount ?? replies.filter((r) => r.unread).length,
        token: partial.token ?? { value: "tok-1", expiresAt: 1_900_000_000_000 },
        renewedSession: partial.renewedSession ?? null,
        persona: partial.persona ?? {
          proxyKey: creds.persona.proxyKey,
          userAgent: creds.persona.userAgent ?? "UA/1",
        },
      };
    },
  };
  return fake;
}

export interface FakePush extends PushService {
  sent: PushMessage[][];
  /** The options of each send, in order. */
  options: (PushSendOptions | undefined)[];
  removed: string[];
  result?: (messages: readonly PushMessage[]) => PushSendResult;
}

export function fakePush(): FakePush {
  const fake: FakePush = {
    sent: [],
    options: [],
    removed: [],
    async send(messages, options) {
      fake.sent.push([...messages]);
      fake.options.push(options);
      return fake.result?.(messages) ?? { sent: messages.length, failed: 0 };
    },
    removeDevice(token) {
      fake.removed.push(token);
    },
  };
  return fake;
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
