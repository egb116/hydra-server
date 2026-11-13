import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Blocklist,
  compilePattern,
  normalizeBlocklistText,
  parsePatterns,
} from "../src/blocklist.ts";

test("prefix wildcard", () => {
  const list = new Blocklist(["okbuddy*"]);
  assert.equal(list.match("OkBuddyBaka"), "okbuddy*");
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


test("normalize sorts by name ignoring wildcards and dedupes", () => {
  assert.equal(
    normalizeBlocklistText("*zzz*\nOkBuddy*\n*dank*\nokbuddy*\n*Dank*, memes\n\n"),
    "*dank*\nmemes\nokbuddy*\n*zzz*\n",
  );
});

test("normalize keeps comments", () => {
  assert.equal(
    normalizeBlocklistText("# my list\nzeta  # last\nalpha\nzeta\n# second note"),
    "# my list\n# second note\nalpha\nzeta  # last\n",
  );
});

test("normalize of empty text is empty", () => {
  assert.equal(normalizeBlocklistText("  \n\n"), "");
});

test("suffix, mid-wildcard, doubled stars and catch-all", () => {
  const list = new Blocklist(["*porn", "a*z", "**cats**"]);
  assert.equal(list.match("EarthPorn"), "*porn");
  assert.equal(list.match("pornography"), null);
  assert.equal(list.match("abcz"), "a*z");
  assert.equal(list.match("abcza"), null);
  assert.equal(list.match("SadCatsClub"), "**cats**");
  assert.equal(new Blocklist(["*"]).match("anything"), "*");
});

test("matches agree with a plain regex check on random input", () => {
  const alphabet = "abc";
  const rand = (len: number) =>
    Array.from({ length: len }, () => alphabet[Math.floor(Math.random() * 3)]).join("");
  const patterns = Array.from({ length: 40 }, () => {
    const core = rand(1 + Math.floor(Math.random() * 3));
    return [core, `${core}*`, `*${core}`, `*${core}*`, `${core}?`, `${core}*${rand(1)}`][
      Math.floor(Math.random() * 6)
    ]!;
  });
  const list = new Blocklist(patterns);
  for (let i = 0; i < 500; i++) {
    const name = rand(1 + Math.floor(Math.random() * 8));
    const expected = patterns.some((p) => compilePattern(p).test(name));
    assert.equal(list.match(name) !== null, expected, `${name} vs ${patterns.join(",")}`);
  }
});

test("uppercase patterns from the saved page match mixed-case names", () => {
  const list = new Blocklist(
    parsePatterns(normalizeBlocklistText("*ZZZ*\n*mains*\n")),
  );
  assert.equal(list.match("CissiaMainsZZZ"), "*mains*");
  assert.equal(list.match("SleepyZZZ"), "*zzz*");
  assert.equal(list.match("CipherMainsHSR_"), "*mains*");
});
