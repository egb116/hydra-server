# Hydra server on Cloudflare Workers (blocklist only)

A tiny replacement for the Bun server, made for one person's use. It does two things:

- Answers `/api/status`, which is all the Hydra app needs to unlock Pro features for a custom server.
- Answers `/api/ai/filterPosts` with a **wildcard subreddit blocklist** instead of an AI model.

AI summaries, push notifications, and the Bun dashboard are not included. Those endpoints return 501 or a plain `OK`.

## Patterns

| Pattern | Blocks |
|---|---|
| `OkBuddy*` | r/OkBuddyBaka, r/okbuddyphd, ... |
| `*zzz*` | any subreddit with `zzz` in its name |
| `memes` | r/memes only (no wildcard means exact) |
| `gif?` | r/gifs, r/gifz (`?` is one character) |

Matching ignores case. Patterns go one per line (commas or spaces also work). A leading `r/` is ignored, and `#` starts a comment.

The list comes from two places, and both are applied:

1. The **/blocklist** page on the Worker, which sits behind Cloudflare Access and is saved in Workers KV.
2. Anything typed in the app under **Settings → Filters → Smart Post Filter**.

## Setup

The Worker is served only at `hydra.ericbowers.org`. The `*.workers.dev` URL and preview URLs are turned off in `wrangler.jsonc`.

1. **Cloudflare credentials for GitHub Actions.** In Cloudflare, create an API token from the *Edit Cloudflare Workers* template. Add it to this repo under **Settings → Secrets and variables → Actions** as `CLOUDFLARE_API_TOKEN`, along with `CLOUDFLARE_ACCOUNT_ID`.
2. **Deploy.** Pushing to `main` with changes under `worker/` runs tests and deploys. You can also run **Actions → Deploy Worker → Run workflow**.
3. **Protect the page with Cloudflare Access.** In Zero Trust → Access → Applications, add a *Self-hosted* application:
   - Domain `hydra.ericbowers.org`, path `blocklist`. Protect only that path: the app has to reach `/api/*` without signing in.
   - A policy that allows your email.

   Then put the team domain (`<team>.cloudflareaccess.com`) and the application's AUD tag into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`, and redeploy. The Worker checks the token Access signs, so the page stays locked even if the Access application is removed.
4. **Point the app at the Worker.** Go to Settings → Advanced → Use Custom Server and enter `https://hydra.ericbowers.org`.
5. **Turn on filtering in the app.** The Smart Post Filter text box must not be empty, or the app never asks the server. Patterns typed there count too.

Edit the list at `https://hydra.ericbowers.org/blocklist`.

## Notes

- The app applies this filter on every posts page, including a single subreddit's own page. If you open a blocked subreddit directly, it will look empty.
- Local development: `npm install`, then `npm run dev`. Without a real Access token the /blocklist page refuses requests, so test the matcher with `npm test`.

## Upstream updates

`.github/workflows/sync-upstream.yml` merges `dmilin1/hydra-server` into `main` every day. All the Worker code is in `worker/`, which upstream never touches, so merges shouldn't conflict.

If a merge fails, the workflow opens an issue. The usual cause is that upstream edited its own workflow files, which the Actions token isn't allowed to push. Pressing **Sync fork** on GitHub fixes that.

Upstream changes affect the Bun server only. The Worker is redeployed only when `worker/` changes.
