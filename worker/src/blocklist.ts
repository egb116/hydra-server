/**
 * Subreddit blocklist with wildcard patterns.
 *
 *   OkBuddy*   matches r/OkBuddyRetard, r/okbuddybaka, ...
 *   *zzz*      matches any subreddit with "zzz" anywhere in its name
 *   memes      matches exactly r/memes (and nothing else)
 *   ?          matches exactly one character
 *
 * Matching is case-insensitive and always covers the whole name, so a
 * pattern without a wildcard is an exact match.
 */

const PATTERN_TOKEN = /^[a-z0-9_*?]+$/i;

/**
 * Pulls patterns out of free text: one per line, or separated by commas or
 * spaces. A leading "r/" or "/r/" is dropped, and anything after a "#" on a
 * line is treated as a comment. Tokens that can't be part of a subreddit
 * name are ignored rather than rejected.
 */
export function parsePatterns(text: string): string[] {
  const patterns = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0] ?? "";
    for (const rawToken of line.split(/[\s,]+/)) {
      const token = rawToken.replace(/^\/?r\//i, "").trim().toLowerCase();
      if (token && PATTERN_TOKEN.test(token)) patterns.add(token);
    }
  }
  return [...patterns];
}

export function compilePattern(pattern: string): RegExp {
  const body = pattern
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${body}$`, "i");
}

export class Blocklist {
  private readonly compiled: { pattern: string; regex: RegExp }[];

  constructor(patterns: string[]) {
    this.compiled = patterns.map((pattern) => ({
      pattern,
      regex: compilePattern(pattern),
    }));
  }

  get size() {
    return this.compiled.length;
  }

  /** Returns the first pattern that blocks this subreddit, or null. */
  match(subreddit: string): string | null {
    const name = subreddit.replace(/^\/?r\//i, "").trim();
    if (!name) return null;
    for (const { pattern, regex } of this.compiled) {
      if (regex.test(name)) return pattern;
    }
    return null;
  }
}
