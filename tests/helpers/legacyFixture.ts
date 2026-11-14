/**
 * Builds a v1-schema database with synthetic rows, using v1's own migration
 * SQL (copied to tests/fixtures/legacy-schema so it outlives the v1 code).
 * Delete together with src/db/legacyImport.ts.
 */
import { Database } from "bun:sqlite";
import { createCipheriv, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_DIR = join(import.meta.dirname, "..", "fixtures", "legacy-schema");

/** v1's utils/crypto.ts encrypt(), verbatim apart from taking the key as an argument. */
export function v1Encrypt(text: string, keyHex: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(keyHex, "hex"), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

/** Applies v1's 0000 and 0001 migrations the way drizzle did, journal table included. */
export function applyV1Schema(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => /^000[01]_.*\.sql$/.test(f))
    .sort();
  if (files.length !== 2) throw new Error(`expected 2 v1 migration files, found ${files.length}`);
  files.forEach((file, i) => {
    const sql = readFileSync(join(SCHEMA_DIR, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) db.run(stmt);
    }
    db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
      `fixture-${file}`,
      1_744_000_000_000 + i,
    ]);
  });
}

export interface FixtureCustomer {
  customerId: string;
  isSubscribed: number | null;
  pushToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FixtureAccount {
  customerId: string;
  username: string;
  session: string;
  /** The v1 ciphertext stored in the row. */
  sessionEnc: string;
  lastMessageId: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FixtureAiRequest {
  customerId: string;
  month: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalSpent: number;
}

export interface LegacyFixture {
  path: string;
  keyHex: string;
  customers: FixtureCustomer[];
  accounts: FixtureAccount[];
  aiRequests: FixtureAiRequest[];
  taskCount: number;
}

/**
 * Creates a v1 database at `path` (WAL mode, like v1) and closes it.
 * Covers: both v1 timestamp formats and an unparseable one, a v1-encrypted
 * session, an ISO watermark, a null watermark, an old message-id watermark,
 * a watermark from before v1's new-inbox cutoff, customers with and without
 * a push token, two customers sharing a push token, an orphan account,
 * ai_requests rows and tasks rows.
 */
export function legacyFixture(path: string, keyHex: string): LegacyFixture {
  const customers: FixtureCustomer[] = [
    {
      customerId: "cust_pro",
      isSubscribed: 1,
      pushToken: "ExponentPushToken[pro-device]",
      createdAt: "2025-03-01 12:34:56",
      updatedAt: "2026-11-01T10:00:00.000Z",
    },
    {
      customerId: "cust_free",
      isSubscribed: 0,
      pushToken: null,
      createdAt: "2025-05-05 05:05:05",
      updatedAt: "2025-05-06 06:06:06",
    },
    {
      customerId: "cust_shared_old",
      isSubscribed: null,
      pushToken: "ExponentPushToken[shared]",
      createdAt: "2025-01-01 00:00:00",
      updatedAt: "2025-01-01 00:00:00",
    },
    {
      customerId: "cust_shared_new",
      isSubscribed: 1,
      pushToken: "ExponentPushToken[shared]",
      createdAt: "not a timestamp",
      updatedAt: "2026-01-01 00:00:00",
    },
  ];

  const account = (
    customerId: string,
    username: string,
    lastMessageId: string | null,
    lastCheckedAt: string | null,
  ): FixtureAccount => {
    const session = `session-of-${username}-${"x".repeat(40)}`;
    return {
      customerId,
      username,
      session,
      sessionEnc: v1Encrypt(session, keyHex),
      lastMessageId,
      lastCheckedAt,
      createdAt: "2025-06-01 08:00:00",
      updatedAt: "2026-11-09T20:15:00.123Z",
    };
  };
  const accounts: FixtureAccount[] = [
    account("cust_pro", "alice", "2026-11-05T12:00:00.000Z", "2026-11-09T20:15:00.123Z"),
    account("cust_pro", "bob", null, null),
    account("cust_free", "carol", "t4_abc123", "2026-11-09T19:00:00.000Z"),
    account("cust_shared_old", "dave", null, null),
    account("cust_shared_new", "erin", "2026-10-01T00:00:00.000Z", null),
    account("cust_missing", "zed", "2026-11-06T00:00:00.000Z", null),
  ];

  const aiRequests: FixtureAiRequest[] = [
    {
      customerId: "cust_pro",
      month: "2026-10",
      requestCount: 12,
      inputTokens: 3400,
      outputTokens: 560,
      totalSpent: 0.0123,
    },
    {
      customerId: "cust_free",
      month: "2026-11",
      requestCount: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalSpent: 0.0001,
    },
  ];

  const db = new Database(path, { create: true, readwrite: true });
  try {
    db.run("PRAGMA journal_mode = WAL;");
    applyV1Schema(db);
    for (const c of customers) {
      db.run(
        "INSERT INTO customers (customer_id, is_subscribed, push_token, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
        [c.customerId, c.isSubscribed, c.pushToken, c.createdAt, c.updatedAt],
      );
    }
    for (const a of accounts) {
      db.run(
        "INSERT INTO reddit_accounts (customer_id, username, session, last_message_id, last_checked_at, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          a.customerId,
          a.username,
          a.sessionEnc,
          a.lastMessageId,
          a.lastCheckedAt,
          a.createdAt,
          a.updatedAt,
        ],
      );
    }
    for (const r of aiRequests) {
      db.run(
        "INSERT INTO ai_requests (customer_id, month, request_count, input_tokens, output_tokens, total_spent) VALUES (?, ?, ?, ?, ?, ?)",
        [r.customerId, r.month, r.requestCount, r.inputTokens, r.outputTokens, r.totalSpent],
      );
    }
    const tasks = [
      [
        "CheckForMessages",
        JSON.stringify({ redditAccountId: 1 }),
        null,
        "2026-11-09T20:15:00.000Z",
      ],
      ["CheckForMessages", JSON.stringify({ redditAccountId: 2 }), "SessionError", null],
      ["DemoTask", null, null, null],
    ] as const;
    for (const [type, data, error, completedAt] of tasks) {
      db.run("INSERT INTO tasks (type, data, error, completedAt) VALUES (?, ?, ?, ?)", [
        type,
        data,
        error,
        completedAt,
      ]);
    }
  } finally {
    db.close(true);
  }

  return { path, keyHex, customers, accounts, aiRequests, taskCount: 3 };
}
