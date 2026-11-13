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
import {
  Blocklist,
  normalizeBlocklistText,
  parsePatterns,
} from "./blocklist";
import { renderAdminPage } from "./admin";
import { verifyAccessJwt } from "./access";

export interface Env {
  BLOCKLIST: KVNamespace;
  /** Cloudflare Access team domain, e.g. "yourteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience (AUD) tag of the Access application protecting /blocklist. */
  ACCESS_AUD?: string;
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

  const saved = await getSavedBlocklist(env);
  const fromApp =
    typeof body.filterDescription === "string"
      ? new Blocklist(parsePatterns(body.filterDescription))
      : null;

  const result: Record<string, boolean> = {};
  const hidden: string[] = [];
  const kept: string[] = [];
  let skipped = 0;
  for (const post of body.posts as IncomingPost[]) {
    if (typeof post?.id !== "string") {
      skipped++;
      continue;
    }
    const subreddit = typeof post.subreddit === "string" ? post.subreddit : "";
    const hit = saved.match(subreddit) ?? fromApp?.match(subreddit) ?? null;
    result[post.id] = hit !== null;
    (hit ? hidden : kept).push(hit ? `${subreddit} (${hit})` : subreddit);
  }

  // One line per request, visible with `wrangler tail` or in the dashboard's
  // Workers logs, so it's possible to see what the app actually sent.
  console.log(
    JSON.stringify({
      event: "filterPosts",
      posts: body.posts.length,
      skippedWithoutId: skipped,
      savedPatterns: saved.size,
      appPatterns: fromApp?.size ?? 0,
      hidden,
      kept,
      firstPostFields:
        body.posts[0] && typeof body.posts[0] === "object"
          ? Object.keys(body.posts[0])
          : typeof body.posts[0],
    }),
  );
  return json(result);
}

/**
 * The saved list can hold thousands of patterns, so it's compiled once per
 * Worker instance and only rebuilt when the stored text changes.
 */
let savedCache: { text: string; blocklist: Blocklist } | null = null;

async function getSavedBlocklist(env: Env): Promise<Blocklist> {
  const text = await loadBlocklistText(env);
  if (savedCache?.text !== text) {
    savedCache = { text, blocklist: new Blocklist(parsePatterns(text)) };
  }
  return savedCache.blocklist;
}

async function blocklistPage(req: Request, env: Env): Promise<Response> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return text(
      "Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.jsonc",
      503,
    );
  }
  const identity = await verifyAccessJwt(
    req.headers.get("Cf-Access-Jwt-Assertion"),
    { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD },
  );
  if (!identity) return text("Forbidden", 403);

  let saved = false;
  if (req.method === "POST") {
    const form = await req.formData();
    const value = normalizeBlocklistText(String(form.get("patterns") ?? ""));
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
