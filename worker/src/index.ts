/**
 * A minimal Hydra server for Cloudflare Workers.
 *
 * The Hydra app unlocks Pro features for any custom server that answers
 * /api/status, and sends feed posts to /api/ai/filterPosts whenever the
 * "Smart Post Filter" text box in Settings > Filters is not empty. This
 * Worker answers that endpoint with a wildcard subreddit blocklist instead
 * of an AI model. AI summaries, push notifications and the dashboard from
 * the Bun server are not implemented here.
 */
import { Blocklist, parsePatterns } from "./blocklist";
import { renderAdminPage } from "./admin";

export interface Env {
  BLOCKLIST: KVNamespace;
  /** Password for the /blocklist page. Set with `wrangler secret put`. */
  ADMIN_PASSWORD?: string;
}

const BLOCKLIST_KEY = "blocklist";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const text = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain", ...corsHeaders, ...headers },
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

type IncomingPost = { id?: unknown; subreddit?: unknown };

export async function loadBlocklistText(env: Env): Promise<string> {
  return (await env.BLOCKLIST.get(BLOCKLIST_KEY)) ?? "";
}

/**
 * Same request and response shape as the Bun server's AI filter: a map of
 * post id to `true` when the post should be hidden. Patterns come from the
 * saved blocklist plus anything typed in the app's Smart Post Filter box.
 */
async function filterPosts(req: Request, env: Env): Promise<Response> {
  let body: { filterDescription?: unknown; posts?: unknown };
  try {
    body = await req.json();
  } catch (_e) {
    return text("Invalid JSON", 400);
  }
  if (!Array.isArray(body.posts)) return text("posts must be an array", 400);

  const patterns = new Set(parsePatterns(await loadBlocklistText(env)));
  if (typeof body.filterDescription === "string") {
    for (const p of parsePatterns(body.filterDescription)) patterns.add(p);
  }
  const blocklist = new Blocklist([...patterns]);

  const result: Record<string, boolean> = {};
  for (const post of body.posts as IncomingPost[]) {
    if (typeof post?.id !== "string") continue;
    const subreddit = typeof post.subreddit === "string" ? post.subreddit : "";
    result[post.id] = blocklist.match(subreddit) !== null;
  }
  return json(result);
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** HTTP Basic auth; any username, password must equal ADMIN_PASSWORD. */
async function isAuthorized(req: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch (_e) {
    return false;
  }
  const password = decoded.slice(decoded.indexOf(":") + 1);
  const [a, b] = await Promise.all([
    sha256(password),
    sha256(env.ADMIN_PASSWORD),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function blocklistPage(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return text(
      "Set a password first: npx wrangler secret put ADMIN_PASSWORD",
      503,
    );
  }
  if (!(await isAuthorized(req, env))) {
    return text("Authentication required", 401, {
      "WWW-Authenticate": 'Basic realm="Hydra blocklist", charset="UTF-8"',
    });
  }

  let saved = false;
  if (req.method === "POST") {
    const form = await req.formData();
    const value = String(form.get("patterns") ?? "");
    await env.BLOCKLIST.put(BLOCKLIST_KEY, value);
    saved = true;
  }

  const listText = await loadBlocklistText(env);
  const blocklist = new Blocklist(parsePatterns(listText));
  const testName = new URL(req.url).searchParams.get("test")?.trim() ?? "";
  const test = testName
    ? { name: testName, matchedBy: blocklist.match(testName) }
    : null;

  return new Response(
    renderAdminPage({ listText, count: blocklist.size, saved, test }),
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
      return new Response(null, { headers: corsHeaders });
    }

    switch (pathname) {
      case "/api/status":
        // The app checks for this exact body before accepting the server.
        return text("Hydra server is up");
      case "/api/ai/filterPosts":
        if (req.method !== "POST") break;
        return filterPosts(req, env);
      case "/api/customers/register":
      case "/api/notifications/register":
        // The app calls these on launch; there is nothing to store.
        if (req.method !== "POST") break;
        return text("OK");
      case "/":
        return Response.redirect(new URL("/blocklist", req.url).toString());
      case "/blocklist":
        if (req.method !== "GET" && req.method !== "POST") break;
        return blocklistPage(req, env);
    }

    if (pathname.startsWith("/api/ai/")) {
      return text("AI features are disabled on this server", 501);
    }
    return text("Not found", 404);
  },
} satisfies ExportedHandler<Env>;
