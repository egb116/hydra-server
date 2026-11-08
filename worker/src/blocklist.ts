/**
 * Subreddit blocklist with wildcard patterns.
 *
 *   OkBuddy*   matches r/OkBuddyBaka, r/okbuddyphd, ...
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

/** Sort key: the name without wildcards, so "*dank*" files under "d". */
const sortKey = (pattern: string) => pattern.replace(/[*?]/g, "");

/**
 * Rewrites blocklist text as one pattern per line, lowercased, deduplicated
 * and sorted alphabetically (ignoring wildcards). Whole-line comments stay at
 * the top in their original order; a trailing comment stays with the first
 * pattern on its line. Tokens that aren't valid patterns are dropped, the
 * same as when matching.
 */
export function normalizeBlocklistText(text: string): string {
  const headerComments: string[] = [];
  const comments = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const hash = rawLine.indexOf("#");
    const body = hash === -1 ? rawLine : rawLine.slice(0, hash);
    const comment = hash === -1 ? "" : rawLine.slice(hash).trim();
    const patterns = parsePatterns(body);

    if (patterns.length === 0) {
      if (comment) headerComments.push(comment);
      continue;
    }
    patterns.forEach((pattern, i) => {
      const existing = comments.get(pattern);
      // Keep the first comment seen for a pattern that appears twice.
      comments.set(pattern, existing || (i === 0 ? comment : ""));
    });
  }

  const sorted = [...comments.keys()].sort((a, b) => {
    const byName = sortKey(a).localeCompare(sortKey(b));
    return byName !== 0 ? byName : a.localeCompare(b);
  });
  const lines = [
    ...headerComments,
    ...sorted.map((p) => {
      const comment = comments.get(p);
      return comment ? `${p}  ${comment}` : p;
    }),
  ];
  return lines.length ? `${lines.join("\n")}\n` : "";
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

/**
 * Matches in time that doesn't grow with the size of the list. The common
 * shapes (exact, `abc*`, `*abc`, `*abc*`) go into hash maps keyed by their
 * literal part. A subreddit name is at most 21 characters, so checking every
 * prefix, suffix and substring of it is a few hundred lookups at most.
 * Anything else (`?`, or a `*` in the middle) falls back to a regex.
 */
export class Blocklist {
  private readonly exact = new Map<string, string>();
  private readonly prefixes = new Map<string, string>();
  private readonly suffixes = new Map<string, string>();
  private readonly contains = new Map<string, string>();
  private readonly regexes: { pattern: string; regex: RegExp }[] = [];
  private matchAll: string | null = null;
  private readonly count: number;

  constructor(patterns: string[]) {
    const unique = new Set(patterns.map((p) => p.toLowerCase()));
    this.count = unique.size;
    for (const pattern of unique) {
      // "**" means the same as "*".
      const p = pattern.replace(/\*+/g, "*");
      const core = p.replace(/^\*/, "").replace(/\*$/, "");
      const starts = p.startsWith("*");
      const ends = p.endsWith("*") && p.length > 1;

      if (/[*?]/.test(core)) {
        this.regexes.push({ pattern, regex: compilePattern(p) });
      } else if (core === "") {
        this.matchAll ??= pattern; // "*" blocks everything
      } else if (starts && ends) {
        if (!this.contains.has(core)) this.contains.set(core, pattern);
      } else if (starts) {
        if (!this.suffixes.has(core)) this.suffixes.set(core, pattern);
      } else if (ends) {
        if (!this.prefixes.has(core)) this.prefixes.set(core, pattern);
      } else if (!this.exact.has(core)) {
        this.exact.set(core, pattern);
      }
    }
  }

  get size() {
    return this.count;
  }

  /** Returns a pattern that blocks this subreddit, or null. */
  match(subreddit: string): string | null {
    const name = subreddit.replace(/^\/?r\//i, "").trim().toLowerCase();
    if (!name) return null;
    if (this.matchAll) return this.matchAll;

    const exact = this.exact.get(name);
    if (exact) return exact;

    const n = name.length;
    if (this.prefixes.size || this.suffixes.size) {
      for (let len = 1; len <= n; len++) {
        const prefix = this.prefixes.get(name.slice(0, len));
        if (prefix) return prefix;
        const suffix = this.suffixes.get(name.slice(n - len));
        if (suffix) return suffix;
      }
    }
    if (this.contains.size) {
      for (let start = 0; start < n; start++) {
        for (let end = start + 1; end <= n; end++) {
          const hit = this.contains.get(name.slice(start, end));
          if (hit) return hit;
        }
      }
    }
    for (const { pattern, regex } of this.regexes) {
      if (regex.test(name)) return pattern;
    }
    return null;
  }
}
