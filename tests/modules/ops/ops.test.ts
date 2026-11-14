/**
 * Regression tests for the ops files (Dockerfile, .dockerignore, lint and format config). Docker
 * itself can't run here, so these check the files statically and run the image's entrypoint
 * script with the local `sh`. CI's `docker` job covers the real image (root-owned /data,
 * non-root start).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const read = (path: string): string =>
  readFileSync(join(ROOT, path), "utf8").replaceAll("\r\n", "\n");

// --- .dockerignore -----------------------------------------------------------------------------

/**
 * Docker's .dockerignore semantics, close enough for these patterns: each pattern is matched
 * against the root-relative path, `*` stays within one segment, `**` spans any number of
 * segments, and a path is excluded when the pattern matches it or any of its parent
 * directories. A `!` pattern re-includes. The last matching pattern wins.
 */
function dockerIgnore(contents: string): (path: string) => boolean {
  const rules = contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      const pattern = (negate ? line.slice(1) : line).replace(/^\/+/, "").replace(/\/+$/, "");
      return { negate, glob: new Bun.Glob(pattern) };
    });
  return (path) => {
    const segments = path.split("/");
    const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
    let excluded = false;
    for (const rule of rules) {
      if (prefixes.some((prefix) => rule.glob.match(prefix))) excluded = !rule.negate;
    }
    return excluded;
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(relative(ROOT, full).replaceAll("\\", "/"));
  }
  return out;
}

/**
 * drizzle-kit's word lists for generated migration names (`<n>_<adjective>_<hero>`), read from
 * its bundle, plus words known to be risky. If drizzle-kit is installed but the lists can't be
 * found, the test fails rather than silently checking only the fixed words.
 */
function drizzleMigrationWords(): string[] {
  const words = new Set(["old", "old_lace", "dist", "data", "config", "bak", "db", "env"]);
  const bin = join(ROOT, "node_modules", "drizzle-kit", "bin.cjs");
  if (existsSync(bin)) {
    const source = readFileSync(bin, "utf8");
    for (const name of ["adjectives", "heroes"]) {
      const list = new RegExp(`\\b${name} = \\[([^\\]]*)\\]`).exec(source)?.[1];
      const found = [...(list ?? "").matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
      expect({ name, enough: found.length > 100 }).toEqual({ name, enough: true });
      for (const word of found) words.add(word);
    }
  }
  return [...words];
}

describe(".dockerignore", () => {
  const ignored = dockerIgnore(read(".dockerignore"));

  test("excludes nothing the image needs: package.json, bun.lock and every file under src/", () => {
    const needed = ["package.json", "bun.lock", ...walk(join(ROOT, "src"))];
    expect(needed.length).toBeGreaterThan(10);
    expect(needed.filter(ignored)).toEqual([]);
  });

  test("never drops a future drizzle-kit migration, whatever words its name uses", () => {
    const words = drizzleMigrationWords();
    const dropped: string[] = [];
    for (const word of words) {
      for (const tag of [`0001_${word}_wolverine`, `0001_brave_${word}`]) {
        for (const path of [
          `src/db/migrations/${tag}.sql`,
          `src/db/migrations/meta/${tag.slice(0, 4)}_snapshot.json`,
        ]) {
          if (ignored(path)) dropped.push(path);
        }
      }
    }
    expect(dropped).toEqual([]);
  });

  test("keeps databases, backups, rollback copies and secrets out of the context", () => {
    for (const path of [
      ".env",
      ".env.local",
      "sqlite.db",
      "sqlite.db-wal",
      "sqlite.db-shm",
      "sqlite.db_old",
      "sqlite.db_old.README.txt",
      "sqlite.db_old.replaced-1700000000000",
      "sqlite.db.daily.bak",
      "sqlite.db.pre-0001_x.bak",
      "data/sqlite.db",
      "data/sqlite.db_old",
      "nested/dir/sqlite.db_old",
      "nested/other.db",
      "config/x.json",
      "node_modules/hono/package.json",
      ".git/HEAD",
      "tests/main.test.ts",
    ]) {
      expect({ path, ignored: ignored(path) }).toEqual({ path, ignored: true });
    }
  });
});

// --- Dockerfile and its entrypoint ---------------------------------------------------------------

const dockerfile = read("Dockerfile");
const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
const ENTRYPOINT_PATH = "/usr/local/bin/hydra-entrypoint";

function entrypointScript(): string {
  const start = `<<"EOF" ${ENTRYPOINT_PATH}\n`;
  const from = finalStage.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const body = finalStage.slice(from + start.length);
  return body.slice(0, body.indexOf("\nEOF\n") + 1);
}

describe("Dockerfile", () => {
  test("starts as root so the entrypoint can fix /data ownership (no USER in the final stage)", () => {
    expect(finalStage).not.toMatch(/^USER\s/m);
    expect(finalStage).toContain(`ENTRYPOINT ["${ENTRYPOINT_PATH}"]`);
    expect(finalStage).toContain('CMD ["bun", "src/main.ts"]');
    // The build fails if the base image stops providing what the entrypoint relies on.
    expect(finalStage).toContain("setpriv --version");
    expect(finalStage).toContain('test "$(id -u bun):$(id -g bun)" = "1000:1000"');
  });

  test("the entrypoint chowns the data directory and drops to uid 1000 when run as root", () => {
    const script = entrypointScript();
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('db_path="${DATABASE_PATH:-/data/sqlite.db}"');
    expect(script).toMatch(/find "\$data_dir" -xdev .* -exec chown -h 1000:1000 \{\} \+/);
    expect(script).toContain('exec setpriv --reuid=1000 --regid=1000 --init-groups -- "$@"');
    // Root branch first, and it always execs, so the server never runs as root.
    const rootBranch = script.slice(script.indexOf('if [ "$(id -u)" = "0" ]'));
    expect(rootBranch.indexOf("exec setpriv")).toBeLessThan(rootBranch.indexOf("\nfi\n"));
  });
});

const sh = Bun.which("sh");
const uid = process.getuid?.();
const posixNonRoot = process.platform !== "win32" && uid !== undefined && uid !== 0;

/** git-bash and dash both need a POSIX path for DATABASE_PATH to count as absolute. */
const shPath = (path: string): string =>
  path
    .replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/${drive.toLowerCase()}/`)
    .replaceAll("\\", "/");

describe.skipIf(sh == null || uid === 0)("entrypoint, started as non-root", () => {
  let dir: string;
  let script: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hydra-ops-"));
    script = join(dir, "hydra-entrypoint");
    writeFileSync(script, entrypointScript());
  });

  afterEach(() => {
    const data = join(dir, "data");
    if (existsSync(data)) chmodSync(data, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  function run(databasePath: string | undefined) {
    const env: Record<string, string | undefined> = { ...process.env, DATABASE_PATH: databasePath };
    if (databasePath === undefined) delete env.DATABASE_PATH;
    const proc = Bun.spawnSync([sh ?? "sh", shPath(script), "echo", "server-started"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  test("runs the command when the data directory is writable", () => {
    const data = join(dir, "data");
    mkdirSync(data);
    const result = run(shPath(join(data, "sqlite.db")));
    expect(result).toEqual({ code: 0, stdout: "server-started\n", stderr: "" });
  });

  test("runs the command for a relative or in-memory DATABASE_PATH", () => {
    expect(run("./sqlite.db").stdout).toBe("server-started\n");
    expect(run(":memory:").stdout).toBe("server-started\n");
  });

  test.skipIf(!posixNonRoot)(
    "exits 1 with the chown fix when the data directory is not writable",
    () => {
      const data = join(dir, "data");
      mkdirSync(data);
      chmodSync(data, 0o555);
      expect(statSync(data).mode & 0o200).toBe(0);
      const result = run(join(data, "sqlite.db"));
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${data} is not writable by uid ${uid}`);
      expect(result.stderr).toContain("chown -R");
    },
  );
});

// --- lint and format scope ---------------------------------------------------------------------

const bin = (name: string): string =>
  join(ROOT, "node_modules", ".bin", process.platform === "win32" ? `${name}.exe` : name);
const srcFiles = (): string[] =>
  walk(join(ROOT, "src")).filter((path) => path.endsWith(".ts") && !path.includes("/migrations/"));

describe("lint and format scope", () => {
  const V1_DIRS = [
    "frontend",
    "db",
    "routes",
    "services",
    "tasks",
    "schedules",
    "middleware",
    "utils",
  ];

  // The v1 tree is gone, so nothing should ignore its directories. An unanchored "db/" would
  // be gitignore-style and also match src/db/ (and "routes/" src/http/routes/).
  test.each([".oxlintrc.json", ".oxfmtrc.json"])("%s ignores no v1 directory", (file) => {
    const { ignorePatterns } = JSON.parse(read(file)) as { ignorePatterns: string[] };
    for (const dir of V1_DIRS) {
      expect(ignorePatterns).not.toContain(`${dir}/`);
      expect(ignorePatterns).not.toContain(`/${dir}/`);
    }
    expect(ignorePatterns).not.toContain("/index.ts");
  });

  test("oxlint lints every .ts file under src/", () => {
    const files = srcFiles();
    expect(files.some((f) => f.startsWith("src/db/"))).toBe(true);
    const run = Bun.spawnSync([bin("oxlint"), "--format=json", "src"], { cwd: ROOT });
    const report = JSON.parse(run.stdout.toString()) as { number_of_files: number };
    expect(report.number_of_files).toBe(files.length);
  });

  test("oxfmt checks src/db and src/http/routes", () => {
    const run = Bun.spawnSync(
      [bin("oxfmt"), "--check", "src/db/legacyImport.ts", "src/http/routes/status.ts"],
      { cwd: ROOT },
    );
    const out = run.stdout.toString() + run.stderr.toString();
    expect(out).not.toContain("excluded by ignore rules");
    expect(out).toContain("on 2 files");
  });
});
