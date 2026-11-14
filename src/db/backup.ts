import type { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** fsync a file so its contents survive a power loss. */
export function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** fsync a directory so a rename or delete in it is durable. Best effort: Windows can't. */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Not supported on every platform (e.g. Windows); the rename is still atomic.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Writes a consistent single-file copy of the database (including the WAL's
 * contents) to `destPath`, replacing it atomically: VACUUM INTO a temp file,
 * fsync, then rename over the destination.
 */
export function backupDatabase(conn: { sqlite: Database }, destPath: string): void {
  const tmp = `${destPath}.tmp`;
  rmSync(tmp, { force: true });
  try {
    conn.sqlite.run("VACUUM INTO ?", [tmp]);
    fsyncFile(tmp);
    renameSync(tmp, destPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(dirname(destPath));
}

/**
 * Deletes all but the newest `keep` files in `dir` whose names start with
 * `prefix` and end with `suffix`. Returns the deleted paths.
 */
export function rotate(dir: string, prefix: string, suffix: string, keep: number): string[] {
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => {
      const path = join(dir, name);
      return { path, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path));
  const deleted: string[] = [];
  for (const file of files.slice(keep)) {
    rmSync(file.path, { force: true });
    deleted.push(file.path);
  }
  return deleted;
}

/** The path of the single daily backup file for a database. */
export function dailyBackupPath(dbPath: string): string {
  return `${dbPath}.daily.bak`;
}
