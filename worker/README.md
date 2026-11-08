# Hydra server on Cloudflare Workers (blocklist only)

A tiny replacement for the Bun server, made for one person's use. It does two things:

- Answers `/api/status`, which is all the Hydra app needs to unlock Pro features for a custom server.
- Answers `/api/ai/filterPosts` with a **wildcard subreddit blocklist** instead of an AI model.

AI summaries, push notifications, and the Bun dashboard are not included. Those endpoints return 501 or a plain `OK`.

## Patterns

| Pattern | Blocks |
|---|---|
| `OkBuddy*` | r/OkBuddyRetard, r/okbuddybaka, ... |
| `*zzz*` | any subreddit with `zzz` in its name |
| `memes` | r/memes only (no wildcard means exact) |
| `gif?` | r/gifs, r/gifz (`?` is one character) |

Matching ignores case. Patterns go one per line (commas or spaces also work). A leading `r/` is ignored, and `#` starts a comment.

The list comes from two places, and both are applied:

1. The **/blocklist** page on the Worker, which needs a password and is saved in Workers KV.
2. Anything typed in the app under **Settings → Filters → Smart Post Filter**.

## Setup

1. **Cloudflare credentials for GitHub Actions.** In Cloudflare, create an API token from the *Edit Cloudflare Workers* template. In this repo, go to **Settings → Secrets and variables → Actions** and add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID` (shown on the Workers & Pages overview page)
2. **Deploy.** Pushing to `main` with changes under `worker/` runs tests and deploys. You can also run **Actions → Deploy Worker → Run workflow**. The first deploy creates the `BLOCKLIST` KV namespace.
3. **Set the page password:** `cd worker && npx wrangler secret put ADMIN_PASSWORD`, or add it as a secret under the Worker's Settings in the Cloudflare dashboard.
4. **Point the app at the Worker.** Go to Settings → Advanced → Use Custom Server and enter `https://hydra-server.<your-subdomain>.workers.dev`.
5. **Turn on filtering in the app.** The Smart Post Filter text box must not be empty, or the app never asks the server. Patterns typed there count too.

Edit the list at `https://hydra-server.<your-subdomain>.workers.dev/blocklist` (any username, your password).

## Notes

- The app applies this filter on every posts page, including a single subreddit's own page. If you open a blocked subreddit directly, it will look empty.
- Local development: `npm install`, put `ADMIN_PASSWORD=...` in `worker/.dev.vars`, then `npm run dev`. Run `npm test` for the matcher tests.

## Upstream updates

`.github/workflows/sync-upstream.yml` merges `dmilin1/hydra-server` into `main` every day. All the Worker code is in `worker/`, which upstream never touches, so merges shouldn't conflict.

If a merge fails, the workflow opens an issue. The usual cause is that upstream edited its own workflow files, which the Actions token isn't allowed to push. Pressing **Sync fork** on GitHub fixes that.

Upstream changes affect the Bun server only. The Worker is redeployed only when `worker/` changes.
