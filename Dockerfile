# syntax=docker/dockerfile:1

# Hydra server: one Bun process, SQLite on /data.
# The runtime image holds only package.json, bun.lock, production node_modules and src/
# (src/db/migrations ships inside src/). No build step: Bun runs the TypeScript directly.

ARG BUN_VERSION=1.4.4

# --- deps: production dependencies only, from the frozen lockfile ---
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- runtime ---
FROM oven/bun:${BUN_VERSION}-slim
LABEL fly_launch_runtime="Bun"
WORKDIR /app
ENV NODE_ENV=production

# sqlite3 is for operators only: ad-hoc queries over `fly ssh console` (there is no SQL console
# in /admin). The build fails here if the base image ever stops providing what the entrypoint
# relies on: setpriv (util-linux, Essential in Debian) and the `bun` user as uid/gid 1000.
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y sqlite3 \
  && rm -rf /var/lib/apt/lists/* \
  && setpriv --version \
  && test "$(id -u bun):$(id -g bun)" = "1000:1000" \
  && mkdir -p /data \
  && chown bun:bun /data

# The container starts as root only long enough to hand the data directory to `bun` (uid 1000),
# then drops privileges for good. Volumes and bind mounts hide the image's /data, and v1 ran as
# root, so an existing v1 /data, a fresh Fly volume and a Docker-created ./data are all
# root-owned; without this step v2 could not open its database there. Only entries not already
# owned by bun are touched, symlinks are not followed, and other filesystems are skipped.
# Started as non-root (e.g. compose `user: "1000:1000"`), it can't chown, so it checks that the
# directory is writable and otherwise exits with the command that fixes it.
COPY --chmod=0755 <<"EOF" /usr/local/bin/hydra-entrypoint
#!/bin/sh
set -eu
db_path="${DATABASE_PATH:-/data/sqlite.db}"
data_dir=""
case "$db_path" in
  /*) data_dir="$(dirname "$db_path")" ;;
esac
if [ "$data_dir" = "/" ]; then data_dir=""; fi

if [ "$(id -u)" = "0" ]; then
  if [ -n "$data_dir" ]; then
    mkdir -p "$data_dir"
    if ! find "$data_dir" -xdev \( ! -user 1000 -o ! -group 1000 \) -exec chown -h 1000:1000 {} +; then
      echo "hydra-entrypoint: could not give $data_dir to uid 1000; the server may not be able to write it" >&2
    fi
  fi
  export HOME=/home/bun
  exec setpriv --reuid=1000 --regid=1000 --init-groups -- "$@"
fi

if [ -n "$data_dir" ] && [ -d "$data_dir" ] && [ ! -w "$data_dir" ]; then
  echo "hydra-entrypoint: $data_dir is not writable by uid $(id -u). Fix it on the host with: chown -R $(id -u):$(id -g) <the directory mounted at $data_dir>" >&2
  exit 1
fi
exec "$@"
EOF

# Owned by root and only readable by the app user: the code can't be modified at runtime.
COPY package.json bun.lock ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src

EXPOSE 3000
STOPSIGNAL SIGTERM

# No curl in the image: bun fetches /healthz itself. 127.0.0.1 rather than localhost so an
# IPv6-first resolver can't make the check miss an IPv4-only listener. The long start period
# covers the one-time v1 import and pending migrations, which run before the server listens.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/hydra-entrypoint"]
CMD ["bun", "src/main.ts"]
