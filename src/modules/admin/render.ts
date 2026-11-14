import type { AdminStats } from "./stats";

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const h = escapeHtml;

/** "error" is free text that may be long: left-aligned and wrapped, even in a label/value table. */
type Fmt = "text" | "error" | "int" | "num" | "usd" | "time" | "ms" | "bool";

const EMPTY = "–";

function groupThousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function toText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

export function formatValue(kind: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return EMPTY;
  if (kind === "bool") return v ? "yes" : "no";
  if (typeof v !== "number") return toText(v);
  if (!Number.isFinite(v)) return String(v);
  switch (kind) {
    case "int":
      return groupThousands(v);
    case "num":
      return Number.isInteger(v) ? groupThousands(v) : v.toFixed(2);
    case "usd":
      return `$${Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2)}`;
    case "time":
      return `${new Date(v).toISOString().slice(0, 19).replace("T", " ")}Z`;
    case "ms": {
      if (v < 1000) return `${Math.round(v)} ms`;
      const s = v / 1000;
      if (s < 60) return `${s.toFixed(1)} s`;
      if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
      return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    }
    default:
      return String(v);
  }
}

const REFRESH_INTERVAL_MS = 15_000;

/**
 * Reloads the page every 15 s while the tab is visible. The HEAD probe keeps
 * the last good page on screen when the server is unreachable; an expired
 * session follows the gate's redirect to the login page.
 */
const RELOAD_SCRIPT = `setInterval(function () {
  if (!document.hidden) fetch("/admin", { method: "HEAD", cache: "no-store" }).then(function (r) { if (r.ok) location.reload(); }, function () {});
}, ${REFRESH_INTERVAL_MS});`;

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f5f6f8; --fg: #1c2230; --muted: #5d6677; --card: #ffffff;
  --border: #dce0e7; --accent: #2f62c9; --bad: #b42318; --stripe: #f0f2f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1217; --fg: #e3e7ee; --muted: #98a2b4; --card: #171b22;
    --border: #2a303b; --accent: #82a8f5; --bad: #f97066; --stripe: #1c212a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header {
  display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
  padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--card);
}
header h1 { font-size: 17px; margin: 0; }
header .meta { color: var(--muted); }
header form { margin-left: auto; }
main {
  display: grid; gap: 16px; padding: 16px;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
}
section {
  background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px 14px; min-width: 0;
}
section.wide { grid-column: 1 / -1; }
h2 { font-size: 15px; margin: 0 0 8px; }
h3 { font-size: 13px; margin: 12px 0 6px; color: var(--muted); font-weight: 600; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
tbody tr:nth-child(even) > * { background: var(--stripe); }
th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.err { word-break: break-word; }
td.empty { color: var(--muted); text-align: center; }
table.kv th { width: 55%; }
button {
  font: inherit; padding: 6px 14px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg); color: var(--fg);
}
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.login {
  max-width: 360px; margin: 12vh auto; padding: 24px; background: var(--card);
  border: 1px solid var(--border); border-radius: 10px;
}
.login h1 { font-size: 18px; margin: 0 0 16px; }
.login label { display: block; margin-bottom: 6px; color: var(--muted); }
.login input {
  width: 100%; font: inherit; padding: 8px 10px; margin-bottom: 14px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg); color: var(--fg);
}
.login .error { color: var(--bad); margin: 0 0 12px; }
`;

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
}

function isTextFmt(fmt: Fmt): boolean {
  return fmt === "text" || fmt === "error";
}

interface Column {
  key: string;
  label: string;
  fmt: Fmt;
}

/** A label/value table; each row reads one path in the stats. */
function kvTable(
  stats: AdminStats,
  rows: readonly [label: string, path: string, fmt: Fmt][],
): string {
  const body = rows
    .map(([label, path, fmt]) => {
      // Values line up on the right, whatever their type; only long text doesn't.
      const cls = fmt === "error" ? ' class="err"' : ' class="n"';
      return `<tr><th>${h(label)}</th><td${cls}>${h(formatValue(fmt, getPath(stats, path)))}</td></tr>`;
    })
    .join("");
  return `<table class="kv"><tbody>${body}</tbody></table>`;
}

/** A table over an array in the stats. */
function listTable(stats: AdminStats, path: string, columns: readonly Column[]): string {
  const value = getPath(stats, path);
  const rows: unknown[] = Array.isArray(value) ? value : [];
  // A number column's header sits over its right-aligned values.
  const head = columns
    .map((c) => `<th${isTextFmt(c.fmt) ? "" : ' class="n"'}>${h(c.label)}</th>`)
    .join("");
  const body =
    rows.length === 0
      ? `<tr><td colspan="${columns.length}" class="empty">None</td></tr>`
      : rows
          .map(
            (row) =>
              `<tr>${columns
                .map((c) => {
                  const cls = isTextFmt(c.fmt) ? "" : ' class="n"';
                  return `<td${cls}>${h(formatValue(c.fmt, getPath(row, c.key)))}</td>`;
                })
                .join("")}</tr>`,
          )
          .join("");
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const METRIC_COLUMNS: readonly Column[] = [
  { key: "name", label: "Metric", fmt: "text" },
  { key: "value", label: "Value", fmt: "num" },
];

function section(title: string, content: string, wide = false): string {
  return `<section${wide ? ' class="wide"' : ""}><h2>${h(title)}</h2>${content}</section>`;
}

function page(title: string, nonce: string, body: string, script: string | null): string {
  const n = h(nonce);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${h(title)}</title>
<style nonce="${n}">${CSS}</style>
</head>
<body>
${body}
${script === null ? "" : `<script nonce="${n}">${script}</script>`}
</body>
</html>`;
}

/** The dashboard page. Every dynamic value goes through escapeHtml. */
export function renderDashboard(stats: AdminStats, nonce: string): string {
  const header = `<header>
<h1>Hydra admin</h1>
<span class="meta">Mode <b>${h(stats.mode)}</b></span>
<span class="meta">Up since ${h(formatValue("time", stats.bootedAt))}</span>
<span class="meta">Updated ${h(formatValue("time", stats.generatedAt))}</span>
<form method="post" action="/admin/logout"><button type="submit">Log out</button></form>
</header>`;

  const accounts = section(
    "Accounts",
    kvTable(stats, [
      ["Total", "accounts.total", "int"],
      ["Active", "accounts.active", "int"],
      ["Needs reauth", "accounts.needsReauth", "int"],
      ["Due now", "accounts.dueNow", "int"],
      ["Queue lag", "accounts.queueLagMs", "ms"],
    ]),
  );

  const customers = section(
    "Customers and devices",
    kvTable(stats, [
      ["Customers", "customers.total", "int"],
      ["Pro (entitled now)", "customers.pro", "int"],
      ["Customers with a device", "customers.withDevices", "int"],
      ["Devices", "customers.devices", "int"],
    ]),
  );

  const poller = section("Poller (since boot)", listTable(stats, "poller", METRIC_COLUMNS));

  const proxySection = section(
    "Proxy pool",
    kvTable(stats, [
      ["Configured", "proxy.configured", "bool"],
      ["Proxies", "proxy.total", "int"],
      ["Healthy", "proxy.healthy", "int"],
      ["Last refresh", "proxy.lastRefreshAt", "time"],
      ["Last refresh error", "proxy.lastRefreshError", "error"],
    ]),
  );

  const push = section(
    "Push",
    kvTable(stats, [
      ["Tickets awaiting receipts", "push.pendingReceipts", "int"],
      ["Oldest pending ticket", "push.oldestPendingAt", "time"],
    ]) +
      `<h3>Since boot</h3>` +
      listTable(stats, "push.metrics", METRIC_COLUMNS),
  );

  const ai = section(
    `AI spend this month`,
    kvTable(stats, [
      ["Month (UTC)", "ai.month", "text"],
      ["Total", "ai.totalUsd", "usd"],
      ["Calls", "ai.calls", "int"],
      ["Customers with AI usage", "ai.customers", "int"],
    ]) +
      `<h3>By feature</h3>` +
      listTable(stats, "ai.byFeature", [
        { key: "feature", label: "Feature", fmt: "text" },
        { key: "calls", label: "Calls", fmt: "int" },
        { key: "errors", label: "Errors", fmt: "int" },
        { key: "inputTokens", label: "In tokens", fmt: "int" },
        { key: "outputTokens", label: "Out tokens", fmt: "int" },
        { key: "costUsd", label: "Cost", fmt: "usd" },
      ]) +
      `<h3>Top customers</h3>` +
      listTable(stats, "ai.topCustomers", [
        { key: "customer", label: "Customer", fmt: "text" },
        { key: "requests", label: "Requests", fmt: "int" },
        { key: "costUsd", label: "Cost", fmt: "usd" },
      ]),
    true,
  );

  const jobs = section(
    "Jobs",
    listTable(stats, "jobs", [
      { key: "name", label: "Job", fmt: "text" },
      { key: "running", label: "Running", fmt: "bool" },
      { key: "runs", label: "Runs", fmt: "int" },
      { key: "failures", label: "Failures", fmt: "int" },
      { key: "consecutiveFailures", label: "In a row", fmt: "int" },
      { key: "skipped", label: "Skipped", fmt: "int" },
      { key: "lastStart", label: "Last start", fmt: "time" },
      { key: "lastDurationMs", label: "Duration", fmt: "ms" },
      { key: "lastError", label: "Last error", fmt: "text" },
    ]),
    true,
  );

  const errors = section(
    "Recent account errors",
    listTable(stats, "accounts.recentErrors", [
      { key: "username", label: "Username", fmt: "text" },
      { key: "status", label: "Status", fmt: "text" },
      { key: "error", label: "Error", fmt: "text" },
      { key: "at", label: "When", fmt: "time" },
      { key: "consecutiveFailures", label: "Failures", fmt: "int" },
    ]),
    true,
  );

  const other = section(
    "Other metrics (since boot)",
    listTable(stats, "otherMetrics", METRIC_COLUMNS),
  );

  const body = `${header}
<main>
${accounts}
${customers}
${proxySection}
${push}
${poller}
${other}
${ai}
${jobs}
${errors}
</main>`;
  return page("Hydra admin", nonce, body, RELOAD_SCRIPT);
}

/** The login form. `error` is shown above the field. */
export function renderLogin(nonce: string, error: string | null = null): string {
  const message = error === null ? "" : `<p class="error" role="alert">${h(error)}</p>`;
  const body = `<form class="login" method="post" action="/admin/login">
<h1>Hydra admin</h1>
${message}
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button class="primary" type="submit">Log in</button>
</form>`;
  return page("Hydra admin login", nonce, body, null);
}
