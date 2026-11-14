/**
 * Cross-module service interfaces. Modules depend on these, never on each
 * other's internals. main.ts / modules/index.ts builds the implementations and
 * passes them in. Changing an interface here is a cross-module change: update
 * every implementation and caller in the same change.
 */
import type { Database } from "bun:sqlite";
import type { CustomerRow } from "../db/schema";

// ---------------------------------------------------------------- entitlements

export interface EntitlementService {
  /** Upserts the customer row by RevenueCat app user id. Synchronous DB work only. */
  ensureCustomer(customerId: string): CustomerRow;
  getCustomer(customerId: string): CustomerRow | undefined;
  /**
   * Re-reads the entitlement from RevenueCat when the stored check is older than
   * maxAgeMs (default 10 min). Never throws for upstream failures: it keeps the last
   * known state, logs it, and alerts. In selfhost mode it never calls RevenueCat.
   */
  refreshIfStale(customerId: string, maxAgeMs?: number): Promise<void>;
  /** selfhost || (is_pro && (pro_expires_at == null || pro_expires_at > now)) */
  isEntitled(customer: CustomerRow, now: number): boolean;
  /**
   * The gate for Pro routes. Returns the customer, or throws
   * Forbidden("Customer is not subscribed").
   * It decides from the DB alone and never waits on RevenueCat. Denying a Pro
   * row whose pro_expires_at has passed starts a background refresh (at most
   * once a minute per customer), so a renewal unlocks the next request.
   */
  requirePro(customerId: string): CustomerRow;
}

// ------------------------------------------------------------------------ push

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  badge?: number;
  sound?: "default" | null;
  data?: Record<string, unknown>;
}

export interface PushSendResult {
  /** Tickets that Expo accepted. */
  sent: number;
  /** Messages rejected at send time, including dead tokens, which were removed. */
  failed: number;
}

export interface PushSendOptions {
  /**
   * The caller's deadline. Chunks still queued behind the concurrency limit
   * when it aborts are dropped (counted as failed) instead of sent late.
   */
  signal?: AbortSignal;
}

export interface RemoveDeviceOptions {
  /**
   * Only delete the device if it last registered at or before this time (epoch
   * ms). Receipt processing passes the ticket's send time, so a device that
   * registered again since then is kept.
   */
  registeredBefore?: number;
}

export interface PushService {
  /** Chunked, concurrent with a bound, and never throws. Stores tickets for receipt checks. */
  send(messages: readonly PushMessage[], options?: PushSendOptions): Promise<PushSendResult>;
  /** Deletes the device (cascading device_accounts), then prunes orphaned accounts. */
  removeDevice(pushToken: string, options?: RemoveDeviceOptions): void;
}

/** Deletes reddit_accounts with no device_accounts link. Returns the number deleted. */
export type PruneOrphanAccounts = (sqlite: Database) => number;

// ---------------------------------------------------------------------- reddit

export type RedditErrorKind =
  /** 401, or 403 on a token that isn't fresh. The client already retried once with a new token. */
  | "auth"
  /** The handshake or the response shows the session itself is invalid (v1's SessionError). */
  | "session_dead"
  /** An IP-level block (403 HTML on a fresh token, captcha, edge challenge). The proxy is at fault. */
  | "edge_block"
  /** 429 */
  | "rate_limited"
  /** Reddit 5xx */
  | "server"
  /** HTTP 200 but GraphQL errors/no data (for example a retired persisted-query hash). */
  | "graphql_error"
  /** Connection errors or timeouts. The proxy is at fault. */
  | "network"
  /** WEBSHARE_TOKEN is set but no healthy proxy is available (fail closed). */
  | "no_proxy";

/**
 * What a failed fetch still obtained: a handshake succeeded, then the query
 * failed. The poller persists it, so the next check reuses the token (and
 * handshakes with the renewed session) instead of handshaking again, which
 * matters while every query fails (for example a rotated persisted-query hash).
 */
export interface UnusedCredentials {
  /** Null when Reddit rejected it, or the session turned out dead. */
  token: RedditToken | null;
  renewedSession: string | null;
}

export class RedditError extends Error {
  /** Set by the client when the failed fetch made a handshake. */
  unused: UnusedCredentials | undefined;

  constructor(
    readonly kind: RedditErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RedditError";
  }
}

/** The per-account identity Reddit sees. Persisted on reddit_accounts. */
export interface Persona {
  /** Webshare proxy id, or null when polling direct (no WEBSHARE_TOKEN). */
  proxyKey: string | null;
  userAgent: string;
}

export interface RedditToken {
  value: string;
  /** Epoch ms from the JWT exp. */
  expiresAt: number;
}

export interface RedditCredentials {
  accountId: number;
  username: string;
  /** Decrypted session cookie JSON as the app sent it ({name, value}). */
  session: string;
  /** Persisted token, or null if there is none yet. */
  token: RedditToken | null;
  /** Persisted persona fields. The client fills in any that are missing. */
  persona: { proxyKey: string | null; userAgent: string | null };
  /**
   * Set by the poller on a retry after session_dead: prefer a proxy other than
   * this one. Persisted-state counterpart of the client's in-memory avoid map,
   * so it also works after a restart.
   */
  avoidProxyKey?: string | null;
}

/**
 * A reply or mention, merged per comment, exactly as v1's getReplies builds it
 * (tasks/CheckForMessages.ts). title and body are the push notification's title
 * and body, unchanged from v1.
 */
export interface InboxReply {
  /** The comment id. Also the dedupe key stored in notified_items.item_id. */
  itemId: string;
  unread: boolean;
  sentAt: number;
  title: string;
  body: string;
}

export interface InboxResult {
  /** All replies and mentions on the first page, merged per comment, newest first. */
  replies: InboxReply[];
  /** Count of unread replies (v1's badge value). */
  unreadCount: number;
  /** The token actually used. The caller persists it (encrypted) if it changed. */
  token: RedditToken;
  /** Set when Reddit renewed reddit_session during the handshake. The caller persists it (encrypted). */
  renewedSession: string | null;
  /** The persona actually used. The caller persists it if it changed. */
  persona: Persona;
}

export interface RedditClient {
  /**
   * Fetches the first inbox page as the account, following the v1 behaviour of
   * services/RedditGql.ts. Throws
   * RedditError on failure. Honors signal (an overall deadline from the poller).
   */
  fetchInbox(creds: RedditCredentials, signal: AbortSignal): Promise<InboxResult>;
}

export interface ProxyHealthSnapshot {
  configured: boolean;
  total: number;
  healthy: number;
  lastRefreshAt: number | null;
  lastRefreshError: string | null;
}

export interface ProxyPool {
  /** Whether WEBSHARE_TOKEN is configured. When false, requests go direct. */
  readonly enabled: boolean;
  /** Ensures the list is loaded. Refreshes hourly and serves a stale list on failure. */
  ready(): Promise<void>;
  /**
   * The proxy URL for this account. The current key is kept while it is healthy;
   * otherwise one is picked by rendezvous hashing on accountId. With avoidKey set,
   * any other healthy proxy is preferred. Returns null only when the pool is disabled.
   * Throws RedditError("no_proxy") when enabled and none are healthy.
   */
  assign(
    accountId: number,
    currentKey: string | null,
    avoidKey?: string | null,
  ): { key: string; url: string } | null;
  reportSuccess(key: string): void;
  reportFailure(key: string, reason: string): void;
  health(): ProxyHealthSnapshot;
}

// -------------------------------------------------------------------------- ai

export interface ClassifierPost {
  /** A server-assigned index (0..n-1). Never the Reddit id. */
  index: number;
  title: string;
  body?: string;
  subreddit?: string;
  [extra: string]: unknown;
}

export interface PostClassifier {
  readonly name: string;
  /** Returns the indices to HIDE. On partial failure, prefer returning fewer (fail open). */
  classify(
    input: {
      description: string;
      posts: readonly ClassifierPost[];
      /**
       * 0 to 1, higher hides more. Classifiers that score posts hide those
       * whose score is above 1 - sensitivity; a yes/no classifier ignores it.
       * Absent means the default (DEFAULT_FILTER_SENSITIVITY).
       */
      sensitivity?: number;
    },
    signal: AbortSignal,
  ): Promise<{
    hide: Set<number>;
    usage?: { inputTokens: number; outputTokens: number };
    /** Per post, the estimated probability that it matches the description, when the classifier has one. */
    scores?: Map<number, number>;
  }>;
}
