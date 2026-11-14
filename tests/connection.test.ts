import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUSY_TIMEOUT_MS, openConnection } from "../src/db/connection";
import { tempDir } from "./helpers";

let dir: string;
let cleanup: () => void;
beforeEach(() => {
  ({ dir, cleanup } = tempDir());
});
afterEach(() => cleanup());

describe("openConnection", () => {
  // An operator's sqlite3 session holding a write transaction used to block
  // the event loop for 5 s on every poller tick, freezing the whole API.
  test("a write lock held by another connection fails fast instead of freezing the loop", () => {
    const path = join(dir, "sqlite.db");
    const main = openConnection(path);
    const operator = openConnection(path);
    try {
      main.sqlite.run("CREATE TABLE t (x INTEGER)");
      operator.sqlite.run("BEGIN IMMEDIATE");
      const started = performance.now();
      expect(() => main.sqlite.run("INSERT INTO t VALUES (1)")).toThrow(/locked|busy/i);
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(BUSY_TIMEOUT_MS - 50);
      expect(waited).toBeLessThan(2_000);
      // Readers are never blocked (WAL).
      expect(main.sqlite.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
      operator.sqlite.run("ROLLBACK");
      main.sqlite.run("INSERT INTO t VALUES (1)");
    } finally {
      operator.close();
      main.close();
    }
  });

  // Bun on Windows threw EEXIST for mkdirSync(".", { recursive: true }), so a
  // bare DATABASE_PATH ("sqlite.db", the dev default) failed the boot.
  test("a bare relative path (directory '.') opens", () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      openConnection("sqlite.db").close();
      expect(existsSync(join(dir, "sqlite.db"))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  test("a missing parent directory is created", () => {
    const path = join(dir, "nested", "deeper", "sqlite.db");
    openConnection(path).close();
    expect(existsSync(path)).toBe(true);
  });

  test("a file that is not a database fails without leaving the file open", async () => {
    const path = join(dir, "garbage.db");
    await Bun.write(path, "not a database".repeat(500));
    expect(() => openConnection(path)).toThrow();
    // On Windows an open handle would make this rename fail.
    const { renameSync } = await import("node:fs");
    renameSync(path, `${path}.moved`);
  });
});
