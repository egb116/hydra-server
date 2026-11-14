import { describe, expect, test } from "bun:test";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import {
  AiCallError,
  DEFAULT_FILTER_SENSITIVITY,
  hideThreshold,
  JEV_BATCH_SIZE,
  JevPostClassifier,
  LlmPostClassifier,
  parseHideLenient,
  sanitizeHide,
  toClassifierPosts,
} from "../../../src/modules/ai";
import { rejection } from "../../helpers";
import { mockTextModel } from "../../helpers/ai";

describe("hideThreshold", () => {
  test("hide when P(match) > 1 - sensitivity; absent means the default", () => {
    expect(DEFAULT_FILTER_SENSITIVITY).toBe(0.5);
    expect(hideThreshold(undefined)).toBe(0.5);
    expect(hideThreshold(0)).toBe(1);
    expect(hideThreshold(1)).toBe(0);
    expect(hideThreshold(0.75)).toBeCloseTo(0.25, 12);
  });

  test("out-of-range values are clamped (the route rejects them first)", () => {
    expect(hideThreshold(-3)).toBe(1);
    expect(hideThreshold(7)).toBe(0);
  });

  // 1 - 0.9 is 0.0999… in floating point; TypeSafe returns 2-decimal
  // probabilities, so a score of exactly 0.10 must not count as "above".
  test("thresholds are exact at 2-decimal boundaries", () => {
    expect(hideThreshold(0.9)).toBe(0.1);
    expect(hideThreshold(0.8)).toBe(0.2);
    expect(hideThreshold(0.55)).toBe(0.45);
    expect(hideThreshold(0.7)).toBe(0.3);
    for (let cents = 0; cents <= 100; cents++) {
      const s = cents / 100;
      expect(hideThreshold(s) > 1 - s - 1e-9 && hideThreshold(s) < 1 - s + 1e-9).toBe(true);
      // A score exactly at the threshold is never hidden.
      expect(1 - s > hideThreshold(s) + 1e-12).toBe(false);
    }
  });
});

interface BatchState {
  filter_description: string;
  posts: { number: number; title: string }[];
}

/**
 * A decision model answering P = number / 100 for each post of a batch,
 * recording every call's state and tracking concurrency. `fail` fails a whole
 * batch by its first post number; `skip` leaves one post's answer out.
 */
function jevModel(
  options: { delayMs?: number; fail?: (first: number) => boolean; skip?: number } = {},
) {
  let inFlight = 0;
  const stats = {
    calls: 0,
    maxInFlight: 0,
    states: [] as BatchState[],
    questionIds: [] as string[][],
  };
  const mock = new Experimental_DecisionMockModelV4({
    doDecide: async ({ state, questions, abortSignal }) => {
      stats.calls++;
      inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      try {
        if (options.delayMs) await Bun.sleep(options.delayMs);
        abortSignal?.throwIfAborted();
        const part = state[0];
        if (part?.type !== "json") throw new Error("expected one JSON state part");
        const value = part.value as unknown as BatchState;
        stats.states.push(value);
        stats.questionIds.push(Object.keys(questions));
        const first = value.posts[0]?.number ?? -1;
        if (options.fail?.(first)) throw new Error(`batch from ${first} failed`);
        const answers = Object.fromEntries(
          value.posts
            .filter((p) => p.number !== options.skip)
            .map((p) => [
              `post${p.number}`,
              { type: "boolean" as const, probability: p.number / 100 },
            ]),
        );
        return { answers, usage: { inputTokens: 10, outputTokens: 0 }, warnings: [] };
      } finally {
        inFlight--;
      }
    },
  });
  return { mock, stats };
}

/** n posts titled "post <i>". */
function makePosts(n: number) {
  return toClassifierPosts(
    Array.from({ length: n }, (_, i) => ({ title: `post ${i}`, subreddit: "s" })),
  );
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("JevPostClassifier", () => {
  test("up to 50 posts is one call: description once, one question per post", async () => {
    const { mock, stats } = jevModel();
    const c = new JevPostClassifier({ model: mock, timeoutMs: 5_000 });
    const result = await c.classify(
      { description: "no politics", posts: makePosts(50) },
      freshSignal(),
    );
    expect(JEV_BATCH_SIZE).toBe(50);
    expect(stats.calls).toBe(1);
    expect(stats.states[0]!.filter_description).toBe("no politics");
    expect(stats.states[0]!.posts.map((p) => p.number)).toEqual([...Array(50).keys()]);
    expect(stats.questionIds[0]).toEqual([...Array(50).keys()].map((i) => `post${i}`));
    expect(result.scores?.size).toBe(50);
    // Default sensitivity: P > 0.5 is hidden; none of 0.00-0.24 are.
    expect(result.hide.size).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
    expect(result.status).toBe("ok");
  });

  test("bigger requests split into batches of 50; usage is summed and the threshold applies", async () => {
    const { mock, stats } = jevModel();
    const c = new JevPostClassifier({ model: mock, timeoutMs: 5_000 });
    const result = await c.classify(
      { description: "d", posts: makePosts(60), sensitivity: 0.5 },
      freshSignal(),
    );
    expect(stats.calls).toBe(2);
    expect(stats.states.map((s) => s.posts.length).sort((a, b) => a - b)).toEqual([10, 50]);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 0 });
    expect(result.scores?.get(57)).toBeCloseTo(0.57, 12);
    // P = number / 100 > 0.5: posts 51-59.
    expect([...result.hide].sort((a, b) => a - b)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59]);
  });

  test("batches run in parallel up to the concurrency cap", async () => {
    const { mock, stats } = jevModel({ delayMs: 5 });
    const c = new JevPostClassifier({
      model: mock,
      timeoutMs: 5_000,
      batchSize: 10,
      concurrency: 2,
    });
    await c.classify({ description: "d", posts: makePosts(60) }, freshSignal());
    expect(stats.calls).toBe(6);
    expect(stats.maxInFlight).toBe(2);
  });

  test("a failed batch leaves its posts visible; mostly failed is degraded; all failed throws", async () => {
    const { mock: lastFails } = jevModel({ fail: (first) => first === 50 });
    const partial = await new JevPostClassifier({ model: lastFails, timeoutMs: 5_000 }).classify(
      { description: "d", posts: makePosts(60), sensitivity: 1 },
      freshSignal(),
    );
    expect(partial.status).toBe("partial");
    expect(partial.hide.has(55)).toBe(false);
    expect(partial.hide.has(45)).toBe(true);
    expect(partial.degraded).toBeUndefined();

    const { mock: firstFails } = jevModel({ fail: (first) => first === 0 });
    const degraded = await new JevPostClassifier({
      model: firstFails,
      timeoutMs: 5_000,
    }).classify({ description: "d", posts: makePosts(60) }, freshSignal());
    expect(degraded.scores?.size).toBe(10);
    expect(degraded.degraded).toStartWith("50 of 60 posts failed (first: ");

    const { mock: broken } = jevModel({ fail: () => true });
    const err = await rejection(
      new JevPostClassifier({ model: broken, timeoutMs: 5_000 }).classify(
        { description: "d", posts: makePosts(60) },
        freshSignal(),
      ),
    );
    expect(err.message).toContain("failed");
  });

  // Chosen on purpose: no per-post retry. One bad answer fails its batch.
  test("a missing answer for one post fails its whole batch, with no retry", async () => {
    const { mock, stats } = jevModel({ skip: 3 });
    const err = await rejection(
      new JevPostClassifier({ model: mock, timeoutMs: 5_000 }).classify(
        { description: "d", posts: makePosts(10) },
        freshSignal(),
      ),
    );
    expect(err).toBeDefined();
    expect(stats.calls).toBe(1);
  });

  test("the request deadline stops batches still waiting; what finished is kept", async () => {
    const { mock, stats } = jevModel({ delayMs: 40 });
    const c = new JevPostClassifier({ model: mock, timeoutMs: 60, batchSize: 5, concurrency: 1 });
    const result = await c.classify({ description: "d", posts: makePosts(20) }, freshSignal());
    expect(result.status).toBe("partial");
    expect(stats.calls).toBeLessThan(4);
    expect(result.scores?.size).toBeGreaterThan(0);
    expect(result.scores?.size).toBeLessThan(20);
  });

  test("an aborted request throws instead of hiding nothing silently", async () => {
    const { mock, stats } = jevModel();
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(
      new JevPostClassifier({ model: mock, timeoutMs: 5_000 }).classify(
        { description: "d", posts: makePosts(10) },
        controller.signal,
      ),
    );
    expect(err).toBeDefined();
    expect(stats.calls).toBe(0);
  });
});

const posts = toClassifierPosts([
  { title: "a", subreddit: "x" },
  { title: "b", subreddit: "y" },
  { title: "c", subreddit: "z" },
]);

function classifier(text: string, finishReason: "stop" | "length" = "stop") {
  const model = mockTextModel(text, { finishReason, inputTokens: 321, outputTokens: 12 });
  return {
    model,
    classifier: new LlmPostClassifier({
      model,
      maxOutputTokens: 500,
      timeoutMs: 5_000,
    }),
  };
}

describe("LlmPostClassifier", () => {
  test("structured output: returns the hidden indices and usage", async () => {
    const { classifier: c, model } = classifier('{"hide":[0,2]}');
    const result = await c.classify({ description: "d", posts }, new AbortController().signal);
    expect([...result.hide].sort((a, b) => a - b)).toEqual([0, 2]);
    expect(result.usage).toEqual({ inputTokens: 321, outputTokens: 12 });
    expect(result.status).toBe("ok");
    const call = model.doGenerateCalls[0]!;
    expect(call.responseFormat).toMatchObject({ type: "json" });
    expect(call.maxOutputTokens).toBe(500);
  });

  test("drops out-of-range, negative and non-integer indices (fail open)", async () => {
    const { classifier: c } = classifier('{"hide":[1,3,-1,1.5,99]}');
    const result = await c.classify({ description: "d", posts }, new AbortController().signal);
    expect([...result.hide]).toEqual([1]);
  });

  test("falls back to jsonrepair when the structured parse fails", async () => {
    const { classifier: c } = classifier('Sure! {"hide": [2,]}');
    const result = await c.classify({ description: "d", posts }, new AbortController().signal);
    expect([...result.hide]).toEqual([2]);
    expect(result.status).toBe("repaired");
  });

  test("garbage fails open with usage", async () => {
    const { classifier: c } = classifier("no idea");
    const result = await c.classify({ description: "d", posts }, new AbortController().signal);
    expect(result.hide.size).toBe(0);
    expect(result.status).toBe("parse_error");
    expect(result.usage?.inputTokens).toBe(321);
  });

  test("empty output throws AiCallError carrying usage", async () => {
    const { classifier: c } = classifier("", "length");
    const err = await rejection(
      c.classify({ description: "d", posts }, new AbortController().signal),
    );
    expect(err).toBeInstanceOf(AiCallError);
    expect((err as AiCallError).status).toBe("truncated");
    expect((err as AiCallError).usage).toMatchObject({ inputTokens: 321, outputTokens: 12 });
  });
});

describe("parseHideLenient", () => {
  test("accepts {hide}, a bare array, an index map, fences and truncation", () => {
    expect([...(parseHideLenient('{"hide":[0,1]}', 3) ?? [])]).toEqual([0, 1]);
    expect([...(parseHideLenient("[2, 0]", 3) ?? [])]).toEqual([2, 0]);
    expect([...(parseHideLenient('{"0": true, "1": false, "2": true}', 3) ?? [])]).toEqual([0, 2]);
    expect([...(parseHideLenient('```json\n{"hide": [1', 3) ?? [])]).toEqual([1]);
    expect(parseHideLenient("{}", 3)?.size).toBe(0);
  });

  test("returns null when there is nothing usable", () => {
    expect(parseHideLenient("", 3)).toBeNull();
    expect(parseHideLenient("nothing to see", 3)).toBeNull();
    expect(parseHideLenient('{"other": 1}', 3)).toBeNull();
  });

  test("sanitizeHide ignores non-numbers", () => {
    expect([...sanitizeHide(["1", null, 2, true], 3)]).toEqual([2]);
  });
});
