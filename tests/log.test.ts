import { describe, expect, test } from "bun:test";
import { createLogger, serializeError } from "../src/lib/log";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    level: "debug",
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { log, lines };
}

describe("logger", () => {
  test("an Error with a cyclic cause keeps every field", () => {
    const { log, lines } = capture();
    const err = new Error("db locked");
    (err as { cause?: unknown }).cause = err;
    log.error("job failed", { job: "reconcile", err });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      msg: "job failed",
      job: "reconcile",
      err: { name: "Error", message: "db locked", cause: "[Circular]" },
    });
  });

  test("cyclic objects, Errors inside them and long cause chains are serialized", () => {
    const { log, lines } = capture();
    const graph: Record<string, unknown> = { name: "root" };
    graph["self"] = graph;
    const inner = new Error("inner", { cause: { back: graph } });
    let deep: Error = new Error("level 0");
    for (let i = 1; i < 50; i++) deep = new Error(`level ${i}`, { cause: deep });
    log.warn("odd", { graph, err: new Error("outer", { cause: inner }), deep, n: 10n });
    expect(lines[0]).toMatchObject({
      msg: "odd",
      graph: { name: "root", self: "[Circular]" },
      err: { message: "outer", cause: { message: "inner", cause: { back: "[Circular]" } } },
      n: "10",
    });
    expect(JSON.stringify(lines[0]?.["deep"])).toContain("cause chain too deep");
  });

  test("an unserializable field is replaced; the other fields survive", () => {
    const { log, lines } = capture();
    const hostile = {
      toJSON() {
        throw new Error("no json for you");
      },
    };
    log.error("request failed", { requestId: "r1", hostile, err: new Error("boom") });
    expect(lines[0]).toMatchObject({
      msg: "request failed",
      requestId: "r1",
      err: { message: "boom" },
    });
    expect(String(lines[0]?.["hostile"])).toStartWith("[unserializable:");
  });

  test("serializeError leaves non-Errors alone", () => {
    expect(serializeError("x")).toBe("x");
    expect(serializeError(null)).toBeNull();
  });
});
