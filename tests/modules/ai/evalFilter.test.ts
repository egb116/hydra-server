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
  sweep,
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
      scores: null,
      expectedHide: [],
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

  test("parseArgs: jev, sensitivity and sweep", () => {
    expect(parseArgs(["--classifier", "jev", "--sensitivity", "0.3", "--sweep"])).toMatchObject({
      classifier: "jev",
      sensitivity: 0.3,
      sweep: true,
    });
    expect(parseArgs([])).toMatchObject({ sensitivity: null, sweep: false });
    for (const bad of ["1.2", "-0.1", "", "high"]) {
      expect(() => parseArgs(["--sensitivity", bad])).toThrow();
    }
  });
});

describe("scores and the threshold sweep", () => {
  const evalCase = parseCases(
    JSON.stringify({
      description: "politics",
      posts: [
        { id: "p1", title: "Election" },
        { id: "p2", title: "Senate" },
        { id: "p3", title: "Cats" },
      ],
      hide: ["p1", "p2"],
    }),
    "inline.jsonl",
  )[0]!;

  test("runCase passes the sensitivity and keeps each post's score by id", async () => {
    const seen: (number | undefined)[] = [];
    const scores = new Map([
      [0, 0.9],
      [1, 0.4],
      [2, 0.1],
    ]);
    const result = await runCase(
      {
        name: "fixed",
        classify: async ({ sensitivity }) => {
          seen.push(sensitivity);
          return { hide: new Set([0]), scores };
        },
      },
      evalCase,
      () => 0,
      () => 0,
      0.3,
    );
    expect(seen).toEqual([0.3]);
    expect(result.scores).toEqual({ p1: 0.9, p2: 0.4, p3: 0.1 });
    expect(result.expectedHide).toEqual(["p1", "p2"]);
  });

  test("sweep scores every threshold from one run's scores", () => {
    const result: CaseResult = {
      source: "s",
      description: "d",
      truePositives: [],
      falsePositives: [],
      falseNegatives: [],
      trueNegatives: 0,
      latencyMs: 0,
      costUsd: 0,
      error: null,
      scores: { p1: 0.9, p2: 0.4, p3: 0.1 },
      expectedHide: ["p1", "p2"],
    };
    const unscored: CaseResult = { ...result, scores: null, expectedHide: ["zzz"] };
    const rows = sweep([result, unscored], [0.95, 0.7, 0.5, 0.05]);
    expect(rows.map((r) => [r.threshold, r.sensitivity, r.hidden])).toEqual([
      [0.05, 0.95, 3],
      [0.3, 0.7, 2],
      [0.5, 0.5, 1],
      [0.95, 0.05, 0],
    ]);
    // At 0.3 both matches are caught and the cat isn't: perfect.
    expect(rows[1]).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    // At 0.5 the borderline match is missed.
    expect(rows[2]!.precision).toBe(1);
    expect(rows[2]!.recall).toBe(0.5);
    // At 0.05 everything is hidden, including the cat.
    expect(rows[0]!.precision).toBeCloseTo(2 / 3, 12);
    // Nothing hidden: precision is 1 by convention, recall 0.
    expect(rows[3]).toMatchObject({ precision: 1, recall: 0 });
  });

  // The server and the sweep must agree exactly at a 2-decimal boundary:
  // 1 - 0.9 is 0.0999… in floating point, which used to hide a 0.10 score on
  // the server but not in the sweep.
  test("a score exactly at the threshold is shown, in the sweep as on the server", () => {
    const base: CaseResult = {
      source: "s",
      description: "d",
      truePositives: [],
      falsePositives: [],
      falseNegatives: [],
      trueNegatives: 0,
      latencyMs: 0,
      costUsd: 0,
      error: null,
      scores: { a: 0.1, b: 0.2, c: 0.45 },
      expectedHide: [],
    };
    const [at90, at80, at55] = sweep([base], [0.9, 0.8, 0.55]);
    expect(at90).toMatchObject({ threshold: 0.1, hidden: 2 });
    expect(at80).toMatchObject({ threshold: 0.2, hidden: 1 });
    expect(at55).toMatchObject({ threshold: 0.45, hidden: 0 });
  });
});
