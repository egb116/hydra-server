const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

type AdminPageProps = {
  listText: string;
  count: number;
  saved: boolean;
  test: { name: string; matchedBy: string | null } | null;
};

export function renderAdminPage({
  listText,
  count,
  saved,
  test,
}: AdminPageProps): string {
  const testResult = test
    ? test.matchedBy
      ? `<p class="result blocked">r/${escapeHtml(test.name)} is blocked by <code>${escapeHtml(test.matchedBy)}</code></p>`
      : `<p class="result allowed">r/${escapeHtml(test.name)} is not blocked</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Subreddit Blocklist</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f8; --fg:#1b1b1f; --muted:#62626b; --card:#fff; --border:#d9d9de; --accent:#2f6fde; --ok:#1d7a46; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141417; --fg:#ececf1; --muted:#a0a0aa; --card:#1e1e23; --border:#34343c; --accent:#6c9cff; --ok:#5fcf8e; --bad:#ff8a80; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width:640px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  p { margin:0 0 12px; }
  .muted { color:var(--muted); font-size:.92rem; }
  form { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; margin-top:16px; }
  label { display:block; font-weight:600; margin-bottom:8px; }
  textarea, input[type=text] { width:100%; font:15px/1.4 ui-monospace, Menlo, monospace; color:var(--fg); background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px; }
  textarea { min-height:280px; resize:vertical; }
  button { margin-top:12px; font:inherit; font-weight:600; color:#fff; background:var(--accent); border:0; border-radius:8px; padding:10px 18px; }
  .row { display:flex; gap:8px; align-items:flex-start; }
  .row input { flex:1; }
  .row button { margin-top:0; }
  .saved { color:var(--ok); font-weight:600; }
  .result { margin:12px 0 0; font-weight:600; }
  .blocked { color:var(--bad); } .allowed { color:var(--ok); }
  code { font-family:ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
<main>
  <h1>Subreddit Blocklist</h1>
  <p class="muted">${count} pattern${count === 1 ? "" : "s"} active. One per line. <code>*</code> matches anything, <code>?</code> one character, case doesn't matter. <code>#</code> starts a comment.</p>
  ${saved ? '<p class="saved">Saved. New feed pages use it right away.</p>' : ""}
  <form method="post" action="/blocklist">
    <label for="patterns">Patterns</label>
    <textarea id="patterns" name="patterns" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="OkBuddy*&#10;*zzz*&#10;memes">${escapeHtml(listText)}</textarea>
    <button type="submit">Save</button>
  </form>
  <form method="get" action="/blocklist">
    <label for="test">Test a subreddit</label>
    <div class="row">
      <input id="test" name="test" type="text" autocapitalize="off" autocorrect="off" placeholder="OkBuddyRetard" value="${escapeHtml(test?.name ?? "")}">
      <button type="submit">Check</button>
    </div>
    ${testResult}
  </form>
</main>
</body>
</html>`;
}
