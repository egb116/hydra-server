import { test } from "node:test";
import assert from "node:assert/strict";
import { Blocklist, parsePatterns } from "../src/blocklist.ts";

test("prefix wildcard", () => {
  const list = new Blocklist(["okbuddy*"]);
  assert.equal(list.match("OkBuddyRetard"), "okbuddy*");
  assert.equal(list.match("okbuddy"), "okbuddy*");
  assert.equal(list.match("NotOkBuddy"), null);
});

test("contains wildcard", () => {
  const list = new Blocklist(["*zzz*"]);
  assert.equal(list.match("zzz"), "*zzz*");
  assert.equal(list.match("SleepyZZZcats"), "*zzz*");
  assert.equal(list.match("buzz"), null);
});

test("exact match without wildcards, and ? for one character", () => {
  const list = new Blocklist(["memes", "gif?"]);
  assert.equal(list.match("Memes"), "memes");
  assert.equal(list.match("dankmemes"), null);
  assert.equal(list.match("gifs"), "gif?");
  assert.equal(list.match("gif"), null);
});

test("r/ prefixes are ignored on both sides", () => {
  const list = new Blocklist(parsePatterns("r/pics"));
  assert.equal(list.match("/r/pics"), "pics");
  assert.equal(list.match("pics"), "pics");
});

test("parsePatterns splits on lines, commas, spaces and skips comments", () => {
  assert.deepEqual(
    parsePatterns("OkBuddy*, *zzz*\n# whole-line comment\nmemes  # trailing\n\n/r/Pics"),
    ["okbuddy*", "*zzz*", "memes", "pics"],
  );
});

test("parsePatterns ignores tokens that can't be subreddit names", () => {
  assert.deepEqual(parsePatterns("No politics! (.*) a.b ok_one"), [
    "no",
    "ok_one",
  ]);
});

test("regex characters in patterns are literal", () => {
  // parsePatterns already drops these, but the matcher must never treat
  // a pattern as a raw regex.
  const list = new Blocklist(["a.b"]);
  assert.equal(list.match("axb"), null);
});

test("empty subreddit never matches", () => {
  assert.equal(new Blocklist(["*"]).match(""), null);
});
