import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { describeThrown, toError } from "../src/lib/errors";

const MAIN = join(import.meta.dir, "..", "src", "main.ts").replaceAll("\\", "/");

/**
 * Runs installProcessHandlers in a child process with a fake server, then
 * triggers `trigger`. Returns the child's JSON log lines and exit code.
 */
async function runChild(
  trigger: string,
): Promise<{ lines: Record<string, unknown>[]; code: number }> {
  const script = `
    import { installProcessHandlers } from "${MAIN}";
    import { createLogger } from "${MAIN.replace("main.ts", "lib/log.ts")}";
    const log = createLogger({ level: "debug" });
    const alerter = { alert: async (key, message) => log.info("alert", { key, message }) };
    installProcessHandlers({
      deps: { log, alerter },
      shutdown: async (reason) => log.info("shutdown", { reason }),
    });
    ${trigger}
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  const lines = stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, code };
}

describe("process handlers", () => {
  test("a rejection whose reason can't be stringified is logged and the process keeps running", async () => {
    const { lines, code } = await runChild(`
      Promise.reject(Object.create(null));
      Promise.reject({ [Symbol.toPrimitive]() { throw new Error("nope"); } });
      setTimeout(() => { log.info("still alive"); process.exit(0); }, 100);
    `);
    expect(code).toBe(0);
    expect(lines.filter((l) => l["msg"] === "unhandled rejection")).toHaveLength(2);
    expect(lines.filter((l) => l["msg"] === "alert")).toHaveLength(2);
    expect(lines.some((l) => l["msg"] === "still alive")).toBe(true);
  });

  test("an uncaught exception is logged as JSON, alerted, and shuts down gracefully with exit 1", async () => {
    const { lines, code } = await runChild(`
      setTimeout(() => { throw new Error("timer boom"); }, 10);
    `);
    expect(code).toBe(1);
    const msgs = lines.map((l) => l["msg"]);
    expect(msgs).toEqual(["uncaught exception; shutting down", "alert", "shutdown"]);
    expect(JSON.stringify(lines[0]?.["err"])).toContain("timer boom");
    expect(lines[1]).toMatchObject({ key: "uncaught-exception" });
    expect(lines[2]).toMatchObject({ reason: "uncaughtException" });
  });
});

describe("describeThrown / toError", () => {
  test("never throw, and bound the length", () => {
    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error("nope");
      },
      toJSON() {
        throw new Error("nope");
      },
    };
    expect(describeThrown(Object.create(null))).toBe("{}");
    expect(describeThrown(hostile)).toBe("[object Object]");
    expect(describeThrown(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeThrown(undefined)).toBe("undefined");
    expect(describeThrown("x".repeat(10_000)).length).toBe(500);
    const wrapped = toError("boom-string");
    expect(wrapped.message).toBe("Non-Error thrown: boom-string");
    expect(wrapped.cause).toBe("boom-string");
    const err = new Error("same");
    expect(toError(err)).toBe(err);
  });
});
