# Hydra Server

This is the server behind [Hydra](https://www.hydraapp.io), a Reddit client. If you run your own copy and point the app at it, you get all of the Pro features on your devices for free.

The server checks your Reddit inbox and sends a push notification when someone replies to you or mentions you. It also runs the AI features, like post and comment summaries and post filtering, using your own Groq or OpenAI API key.

## Setup with Docker

You need Docker with Compose. You don't need to clone this repo, since the compose file builds the image straight from GitHub.

```bash
mkdir hydra-server && cd hydra-server
curl -fsSLO https://raw.githubusercontent.com/dmilin1/hydra-server/main/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/dmilin1/hydra-server/main/.env.example
```

Open `.env` and set these:

- `ENCRYPTION_KEY`: run `openssl rand -hex 32` and paste the output. Save a copy somewhere. The server encrypts your Reddit sessions with it, and if you change it the stored sessions can't be read.
- `GROQ_API_KEY`: get one at <https://console.groq.com/keys>. To use OpenAI or another OpenAI-compatible API instead, see [Configuration](#configuration).
- `DASHBOARD_PASSWORD` (optional): turns on the admin page at `/admin`. It has to be at least 16 characters.

Then start it:

```bash
docker compose up -d
curl http://localhost:3000/healthz
```

If the health check returns `{"ok":true,...}`, it's running. `docker compose logs -f` shows the logs. Your data lives in `./data`.

## Connecting the app

In Hydra, go to Settings > Advanced, turn on Use Custom Server under Self Hosted Hydra Server, and enter your server's URL. Once the app says the server checks out, restart the app.

Your phone has to be able to reach the server when you use the app. Notifications are delivered through Expo's push service, so those still arrive when you're away from home.

Anyone who can reach your server can use it, including the AI features on your API key. The easiest way to use it away from home is a VPN like [Tailscale](https://tailscale.com) or WireGuard. If you put it on the public internet instead, put it behind a reverse proxy with HTTPS and set `TRUST_PROXY=1` so rate limits see real client addresses.

## Updating

```bash
docker compose up -d --build
```

If an update changes the database, the server backs it up before applying the change.

## Backups

The server writes a backup to `data/sqlite.db.daily.bak` once a day. It also writes `data/sqlite.db.pre-<migration>.bak` before an update changes the database, and keeps the last three.

To restore the daily backup:

```bash
docker compose down
mkdir -p data/aside
mv data/sqlite.db data/sqlite.db-wal data/sqlite.db-shm data/aside/
cp data/sqlite.db.daily.bak data/sqlite.db
docker compose up -d
```

It's fine if `mv` complains that the `-wal` or `-shm` file doesn't exist. Just don't leave them next to the restored file.

Backups contain your Reddit sessions, encrypted with `ENCRYPTION_KEY`. Keep the key somewhere other than the backups.

## Running without Docker

You need [Bun](https://bun.sh) 1.4.

```bash
git clone https://github.com/dmilin1/hydra-server.git && cd hydra-server
bun install --production
cp .env.example .env
bun run start
```

Edit `.env` the same way as above before starting. The database is created at `./sqlite.db` unless you set `DATABASE_PATH`.

## Configuration

Settings go in `.env`. If one is invalid, the server won't start and the log tells you which.

| Variable | What it does |
| --- | --- |
| `ENCRYPTION_KEY` | Required. 64 hex characters, from `openssl rand -hex 32`. |
| `GROQ_API_KEY` | Key for the AI features when `AI_PROVIDER` is `groq` (the default). |
| `AI_PROVIDER` | `groq` or `openai`. |
| `OPENAI_API_KEY` | Key for the AI features when `AI_PROVIDER` is `openai`. The in-app guide search always uses OpenAI, so it needs this key either way. |
| `OPENAI_BASE_URL` | Point `openai` at any OpenAI-compatible server, such as a local model. |
| `DASHBOARD_PASSWORD` | Turns on `/admin`. At least 16 characters. |
| `WEBSHARE_TOKEN` | Sends Reddit requests through [Webshare](https://www.webshare.io) proxies instead of your own IP. |
| `DISCORD_WEBHOOK_URL` | Posts to a Discord channel when something goes wrong. |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy. |
| `POLL_INTERVAL_MS` | How often each inbox is checked. Defaults to `120000` (2 minutes). |
| `PORT` | Defaults to `3000`. |

[`.env.example`](.env.example) lists the rest.

## Pull requests

Bug fixes are welcome.

Please don't send changes that only make the server fit your own setup, like support for a different database, another hosting platform, or a new option for your environment. I can't maintain every setup people run. If you need something like that, fork the project and make it your own.
