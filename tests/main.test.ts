import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { ConfigError } from "../src/config";
import { startServer } from "../src/main";
import { rejection, TEST_KEY, tempDir } from "./helpers";

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
});
afterEach(() => cleanup());

describe("startServer", () => {
  test("boots, serves, and shuts down gracefully", async () => {
    const lines: Record<string, unknown>[] = [];
    const running = await startServer({
      env: {
        HYDRA_MODE: "selfhost",
        ENCRYPTION_KEY: TEST_KEY,
        DATABASE_PATH: join(dir, "sqlite.db"),
        PORT: "0",
      },
      logSink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    const status = await fetch(new URL("/api/status", running.url));
    expect(status.status).toBe(200);
    expect(await status.text()).toBe("Hydra server is up");
    const health = await fetch(new URL("/healthz", running.url));
    expect(health.status).toBe(200);
    // Selfhost without WEBSHARE_TOKEN: no proxy refresh and no RevenueCat reconcile.
    expect(Object.keys(running.jobs.heartbeats()).sort()).toEqual([
      "ai.prune-calls",
      "db-daily-backup",
      "poller-prune-notified",
      "push-receipts",
      "registration-prune-stale",
    ]);

    await Promise.all([running.shutdown("test"), running.shutdown("again")]);
    expect(lines.filter((l) => l["msg"] === "shutting down")).toHaveLength(1);
    expect(lines.at(-1)?.["msg"]).toBe("stopped");
    // The database is closed and the port no longer accepts connections.
    expect(() => running.deps.sqlite.query("SELECT 1").get()).toThrow();
    expect(await rejection(fetch(new URL("/api/status", running.url)))).toBeInstanceOf(Error);
  });

  // A corrupt database (or a failed migration) used to crash-loop silently
  // until Fly stopped restarting the machine.
  test("a database that can't be opened alerts before the boot fails", async () => {
    const posts: string[] = [];
    const discord = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        posts.push(body);
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => discord.listen(0, "127.0.0.1", resolve));
    const address = discord.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const dbPath = join(dir, "sqlite.db");
      writeFileSync(dbPath, "this is not a sqlite database".repeat(200));
      const err = await rejection(
        startServer({
          env: {
            HYDRA_MODE: "selfhost",
            ENCRYPTION_KEY: TEST_KEY,
            DATABASE_PATH: dbPath,
            PORT: "0",
            DISCORD_WEBHOOK_URL: `http://127.0.0.1:${port}/webhook`,
          },
          logSink: () => {},
        }),
      );
      expect(err).not.toBeInstanceOf(ConfigError);
      expect(posts).toHaveLength(1);
      const { content } = JSON.parse(posts[0] ?? "{}") as { content: string };
      expect(content).toStartWith("Boot failed, the server is not running:");
      expect(content).toContain("sqlite.db.daily.bak");
    } finally {
      discord.close();
    }
  });

  test("bad config throws a ConfigError before touching the database", async () => {
    const err = await rejection(
      startServer({ env: { DATABASE_PATH: join(dir, "sqlite.db") }, logSink: () => {} }),
    );
    expect(err).toBeInstanceOf(ConfigError);
  });
});
