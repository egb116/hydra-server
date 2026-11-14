import { describe, expect, test } from "bun:test";
import {
  AiCallError,
  LlmPostClassifier,
  parseHideLenient,
  sanitizeHide,
  toClassifierPosts,
} from "../../../src/modules/ai";
import { rejection } from "../../helpers";
import { mockTextModel } from "../../helpers/ai";

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
