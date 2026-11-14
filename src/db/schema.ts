/**
 * Every v2 table. All timestamps are INTEGER epoch milliseconds.
 */
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/** Key/value markers, such as `legacy_import_completed_at`. */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const customers = sqliteTable("customers", {
  id: integer("id").primaryKey(),
  customerId: text("customer_id").notNull().unique(),
  isPro: integer("is_pro", { mode: "boolean" }).notNull().default(false),
  /** NULL with isPro = true means no known expiry (lifetime, or legacy import). */
  proExpiresAt: integer("pro_expires_at"),
  entitlementSource: text("entitlement_source"),
  entitlementCheckedAt: integer("entitlement_checked_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** One row per Expo push token; the token is the device identity. */
export const devices = sqliteTable(
  "devices",
  {
    id: integer("id").primaryKey(),
    pushToken: text("push_token").notNull().unique(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    lastRegisteredAt: integer("last_registered_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("devices_customer_id_idx").on(t.customerId)],
);

export type RedditAccountStatus = "active" | "needs_reauth";

export const redditAccounts = sqliteTable(
  "reddit_accounts",
  {
    // AUTOINCREMENT (migration 0002): a deleted account's id is never handed to
    // a new one, so a late check result or in-memory state keyed by id can't
    // reach another account.
    id: integer("id").primaryKey({ autoIncrement: true }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    sessionEnc: text("session_enc").notNull(),
    tokenEnc: text("token_enc"),
    tokenExpiresAt: integer("token_expires_at"),
    status: text("status").$type<RedditAccountStatus>().notNull().default("active"),
    nextCheckAt: integer("next_check_at").notNull(),
    leaseUntil: integer("lease_until"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    sessionFailures: integer("session_failures").notNull().default(0),
    lastSuccessAt: integer("last_success_at"),
    lastError: text("last_error"),
    lastErrorAt: integer("last_error_at"),
    baselineAt: integer("baseline_at").notNull(),
    proxyKey: text("proxy_key"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    unique("reddit_accounts_customer_username_unique").on(t.customerId, t.username),
    index("reddit_accounts_next_check_at_idx").on(t.nextCheckAt),
    // /admin's 50 most recent errors.
    index("reddit_accounts_last_error_at_idx").on(t.lastErrorAt),
  ],
);

export const deviceAccounts = sqliteTable(
  "device_accounts",
  {
    deviceId: integer("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => redditAccounts.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.accountId] }),
    index("device_accounts_account_id_idx").on(t.accountId),
  ],
);

/** Outbox of inbox items already pushed. Pruned after 30 days. */
export const notifiedItems = sqliteTable(
  "notified_items",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => redditAccounts.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    notifiedAt: integer("notified_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.itemId] }),
    index("notified_items_notified_at_idx").on(t.notifiedAt),
  ],
);

export const pushTickets = sqliteTable(
  "push_tickets",
  {
    id: integer("id").primaryKey(),
    ticketId: text("ticket_id").notNull().unique(),
    pushToken: text("push_token").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("push_tickets_created_at_idx").on(t.createdAt)],
);

/** Keyed by the RevenueCat customer id string (not customers.id), like v1's ai_requests. */
export const aiUsageMonthly = sqliteTable(
  "ai_usage_monthly",
  {
    customerId: text("customer_id").notNull(),
    /** 'YYYY-MM' */
    month: text("month").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.month] }),
    // /admin's top customers this month.
    index("ai_usage_monthly_month_cost_idx").on(t.month, t.costUsd),
  ],
);

/** One row per AI provider call. Retained for 90 days. */
export const aiCalls = sqliteTable(
  "ai_calls",
  {
    // AUTOINCREMENT (migration 0002): ids only grow, even after the retention
    // prune empties the table, so /admin can add up new calls by id range.
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    customerId: text("customer_id"),
    clientKey: text("client_key"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    latencyMs: integer("latency_ms").notNull(),
    status: text("status").notNull(),
    error: text("error"),
  },
  (t) => [index("ai_calls_ts_idx").on(t.ts), index("ai_calls_feature_ts_idx").on(t.feature, t.ts)],
);

export type CustomerRow = typeof customers.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type RedditAccountRow = typeof redditAccounts.$inferSelect;
