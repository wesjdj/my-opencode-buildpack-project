/**
 * Filesystem index of pi-agent sessions.
 *
 * pi stores sessions as JSONL under `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`
 * where `<cwd>` is the working directory with `/` replaced by `-`. Each file's first
 * line is the session header `{"type":"session","version","id","timestamp","cwd"}`.
 *
 * We read only the header + a cheap line count per file so listing stays fast even with
 * many sessions. This is read-only; the pi SDK owns writes.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { WireSessionSummary } from "./protocol.ts";

export function agentSessionsDir(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

/** Read the first JSONL line (the session header) without loading the whole file. */
async function readHeader(file: string): Promise<SessionHeader | undefined> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      return obj?.type === "session" ? (obj as SessionHeader) : undefined;
    }
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
  return undefined;
}

/** Count `type:"message"` entries (a cheap proxy for conversation length). */
async function countMessages(file: string): Promise<number> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      // Avoid JSON.parse per line for speed; the role marker is enough.
      if (line.includes('"type":"message"')) n++;
    }
  } catch {
    /* ignore partial/corrupt files */
  } finally {
    rl.close();
  }
  return n;
}

/**
 * List sessions, newest first. If `cwd` is given, restrict to that project's directory;
 * otherwise scan every project directory under the sessions root.
 */
export async function listSessions(cwd?: string): Promise<WireSessionSummary[]> {
  const root = agentSessionsDir();
  let projectDirs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    projectDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("--") && e.name.endsWith("--"))
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }

  if (cwd) {
    const encoded = `--${cwd.replace(/\//g, "-")}--`;
    projectDirs = projectDirs.filter((d) => basename(d) === encoded);
  }

  const summaries: WireSessionSummary[] = [];
  for (const dir of projectDirs) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = join(dir, f);
      const [header, st] = await Promise.all([readHeader(file), stat(file).catch(() => undefined)]);
      if (!header || !st) continue;
      summaries.push({
        id: header.id,
        cwd: header.cwd,
        project: basename(header.cwd) || header.cwd,
        messageCount: await countMessages(file),
        updatedAt: st.mtimeMs,
        sessionFile: file,
      });
    }
  }

  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/** Resolve a session id (full or partial UUID) to its JSONL path. */
export async function resolveSessionFile(sessionId: string): Promise<string | undefined> {
  const all = await listSessions();
  return all.find((s) => s.id === sessionId)?.sessionFile ?? all.find((s) => s.id.startsWith(sessionId))?.sessionFile;
}
