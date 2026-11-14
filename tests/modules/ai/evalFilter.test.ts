/**
 * Checks the eval harness's fixtures and scoring. It never runs the harness's
 * main() or the LLM classifier (scripts/eval-filter.ts guards main with
 * import.meta.main), so no network is touched.
 */
import { describe, expect, test } from "bun:test";
import {
  type CaseResult,
  keywordClassifier,
  loadCases,
  parseArgs,
  parseCases,
  runCase,
  summarize,
} from "../../../scripts/eval-filter";

describe("filter-eval fixtures", () => {
  test("every case is well formed, and there are about 20", () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(18);
    for (const c of cases) {
      const ids = new Set(c.posts.map((p) => p.id));
      for (const id of c.hide) expect(ids.has(id)).toBe(true);
    }
    // At least one case expects nothing hidden.
    expect(cases.some((c) => c.hide.length === 0)).toBe(true);
  });

  test("bad lines are reported with file and line", () => {
    expect(() =>
      parseCases('\n{"description":"d","posts":[{"id":"a","title":"t"}],"hide":["zz"]}', "x.jsonl"),
    ).toThrow(/x\.jsonl:2: hide id "zz"/);
    expect(() => parseCases("{nope", "y.jsonl")).toThrow(/y\.jsonl:1: invalid JSON/);
  });
});

describe("scoring", () => {
  test("runCase counts TP/FP/FN/TN by post id", async () => {
    const [evalCase] = parseCases(
      JSON.stringify({
        description: "d",
        posts: [
          { id: "a", title: "a" },
          { id: "b", title: "b" },
          { id: "c", title: "c" },
          { id: "d", title: "d" },
        ],
        hide: ["a", "b"],
      }),
      "t.jsonl",
    );
    let t = 0;
    const result = await runCase(
      {
        name: "fixed",
        classify: async () => ({
          hide: new Set([0, 2]),
          usage: { inputTokens: 10, outputTokens: 1 },
        }),
      },
      evalCase!,
      (usage) => usage.inputTokens / 1000,
      () => (t += 50),
    );
    expect(result).toMatchObject({
      truePositives: ["a"],
      falsePositives: ["c"],
      falseNegatives: ["b"],
      trueNegatives: 1,
      latencyMs: 50,
      costUsd: 0.01,
      error: null,
    });
  });

  test("a throwing classifier hides nothing and is counted as an error", async () => {
    const [evalCase] = parseCases(
      JSON.stringify({ description: "d", posts: [{ id: "a", title: "a" }], hide: ["a"] }),
      "t.jsonl",
    );
    const result = await runCase(
      {
        name: "broken",
        classify: async () => {
          throw new Error("boom");
        },
      },
      evalCase!,
    );
    expect(result.error).toBe("Error: boom");
    expect(result.falseNegatives).toEqual(["a"]);
  });

  test("summarize computes micro precision, recall and F1", () => {
    const base: CaseResult = {
      source: "s",
      description: "d",
      truePositives: [],
      falsePositives: [],
      falseNegatives: [],
      trueNegatives: 0,
      latencyMs: 10,
      costUsd: 0.5,
      error: null,
    };
    const summary = summarize([
      { ...base, truePositives: ["a", "b", "c"], falsePositives: ["x"], latencyMs: 100 },
      { ...base, falseNegatives: ["y"], trueNegatives: 4, latencyMs: 300 },
    ]);
    expect(summary.precision).toBeCloseTo(0.75, 10);
    expect(summary.recall).toBeCloseTo(0.75, 10);
    expect(summary.f1).toBeCloseTo(0.75, 10);
    expect(summary.latencyP50Ms).toBe(100);
    expect(summary.latencyP95Ms).toBe(300);
    expect(summary.totalCostUsd).toBe(1);
    expect(summary.perfectCases).toBe(0);
  });

  test("the offline keyword baseline runs over the fixtures", async () => {
    const classifier = keywordClassifier();
    const results = await Promise.all(loadCases().map((c) => runCase(classifier, c)));
    const summary = summarize(results);
    expect(summary.errors).toBe(0);
    expect(summary.truePositives).toBeGreaterThan(0);
  });

  test("parseArgs", () => {
    expect(parseArgs(["--classifier", "keyword", "--case", "Politics", "--json"])).toMatchObject({
      classifier: "keyword",
      filter: "politics",
      json: true,
    });
    expect(() => parseArgs(["--classifier", "magic"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
  });
});
