# filterPosts evaluation cases

Labeled cases for `scripts/eval-filter.ts`, the offline harness for post-filter classifiers.

## These cases are SYNTHETIC

Every case in `synthetic.jsonl` was written by hand for this repo. The posts, ids and subreddits are made up. They cover the common kinds of filter (topics, spoilers, self-promotion, rage bait, languages) and two adversarial ones:

- a description that matches nothing
- posts that try prompt injection or try to break out of the prompt's delimiters

They are a smoke test for prompt and model changes. They do not measure real-world accuracy. Real filter descriptions are vaguer and real feeds are noisier. Do not tune a prompt to these cases alone.

## Format

One JSON object per line (JSONL), in any `*.jsonl` file in this folder:

```json
{"description": "posts about politics",
 "posts": [{"id": "abc123", "title": "...", "body": "...", "subreddit": "news"}],
 "hide": ["abc123"]}
```

- `description`: the user's smart-filter text, exactly as typed in Settings.
- `posts[]`: `id` and `title` are required. `body` (the app sends the first 500 characters of the post text) and `subreddit` are optional.
- `hide[]`: the ids of the posts that should be hidden. Every id must appear in `posts`. Every other post should be shown.

## Running

```sh
# Offline baseline, with no network and no keys:
bun scripts/eval-filter.ts --classifier keyword

# The real classifier. It reads keys from the environment only
# (Bun also loads ./.env automatically). It makes real, billed API calls.
GROQ_API_KEY=... bun scripts/eval-filter.ts
AI_PROVIDER=openai OPENAI_API_KEY=... AI_MODEL_FILTER=gpt-4.1-mini bun scripts/eval-filter.ts

# Options
bun scripts/eval-filter.ts --dir tests/fixtures/filter-eval --case politics --json
```

The harness prints each case's result (hits, false positives and misses), then the micro-averaged precision, recall and F1, the latency (p50/p95) and the total estimated cost. "Positive" means hidden. Precision is the share of hidden posts that should have been hidden. Recall is the share of posts that should have been hidden that were hidden.

The harness never runs under `bun test`. `tests/modules/ai/evalFilter.test.ts` only checks that the fixtures are well formed and that the scoring math is right, using the offline keyword baseline.

## Collecting real labeled cases

Real cases are worth far more than synthetic ones. To collect them:

1. Use descriptions that real users would write. Ask beta testers or Pro users who opt in. The server never stores filter descriptions or posts, and must not start logging them to build a dataset.
2. For each description, take one or two real listing pages (25 to 100 posts) from the feeds that user reads. Keep `id`, `title`, the first 500 characters of the body, and `subreddit`, which is the same shape the app sends.
3. Have a person (ideally two, then reconcile) label which posts they would want hidden. Record the borderline posts too: these are where classifiers differ.
4. Remove anything that identifies a user: usernames in titles or bodies, and anything a user typed that they did not agree to share.
5. Save the result as `real-<topic>.jsonl` here. If the content cannot be committed, keep it in a private file and point `--dir` at it.

Re-run the harness whenever the prompt, the model, the provider options or the classifier backend changes, and compare F1, latency and cost with the previous run.
