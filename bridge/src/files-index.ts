/**
 * Lightweight project file index for the composer's `@` file-mention autocomplete.
 *
 * Walks the session cwd, skipping VCS/dependency/build noise, and returns workspace-relative
 * paths filtered by a substring query. Bounded by both a walk cap (cost) and a result cap.
 * Read-only and listing-only — it never opens a client-supplied path, so there is no traversal
 * risk; the query is a pure filter over names we discovered ourselves.
 */

import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Directory names never worth suggesting. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  ".idea",
  ".vscode",
]);

const WALK_CAP = 8000; // max entries visited before we stop scanning

export interface ListFilesOptions {
  query?: string;
  limit?: number;
}

/**
 * Return up to `limit` workspace-relative file paths under `root` matching `query`
 * (case-insensitive substring on the relative path). Directories are not returned.
 */
export async function listProjectFiles(root: string, opts: ListFilesOptions = {}): Promise<string[]> {
  const query = (opts.query ?? "").toLowerCase();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const out: string[] = [];
  let visited = 0;

  // Breadth-first so shallow (usually more relevant) matches surface first.
  const queue: string[] = [root];
  while (queue.length > 0 && out.length < limit && visited < WALK_CAP) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (visited >= WALK_CAP) break;
      visited++;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, abs).split(sep).join("/");
      if (query === "" || rel.toLowerCase().includes(query)) {
        out.push(rel);
        if (out.length >= limit) break;
      }
    }
  }
  out.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return out;
}
