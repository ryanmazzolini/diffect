import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Captures the JSON string value of the first `"cwd": "..."` in a session log. */
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export type SessionLogKind = "pi" | "claude";

export interface SessionProject {
  /** Stable provider-local project identity (the directory containing session logs). */
  projectDir: string;
  sessionFile: string;
  cwd: string;
  lastActiveAt: number;
}

/**
 * Return the newest session for each project directory, newest project first.
 * Missing roots, malformed logs, and unreadable projects are skipped independently.
 */
export async function scanSessionProjects(
  root: string,
  kind: SessionLogKind,
): Promise<SessionProject[]> {
  const dirents = await readdir(root, { withFileTypes: true }).catch(() => []);
  const projects = await Promise.all(
    dirents.map(async (dirent): Promise<SessionProject | null> => {
      if (!dirent.isDirectory() || (kind === "pi" && /test/i.test(dirent.name))) {
        return null;
      }
      const projectDir = join(root, dirent.name);
      const newest = await newestSession(projectDir);
      if (!newest) return null;
      const cwd = (await readSessionCwd(newest.file)) ?? decodeDirName(dirent.name, kind);
      return cwd
        ? {
            projectDir,
            sessionFile: newest.file,
            cwd: resolve(cwd),
            lastActiveAt: Math.round(newest.mtime),
          }
        : null;
    }),
  );
  return projects
    .filter((project): project is SessionProject => project !== null)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/** The cwd is recorded near the session header, so read only the first 64 KiB. */
export async function readSessionCwd(file: string): Promise<string | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const match = buffer.toString("utf8", 0, bytesRead).match(CWD_RE);
    if (!match) return null;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

async function newestSession(
  dir: string,
): Promise<{ file: string; mtime: number } | null> {
  const files = (await readdir(dir).catch(() => [])).filter((file) =>
    file.endsWith(".jsonl"),
  );
  let newest: { file: string; mtime: number } | null = null;
  for (const file of files) {
    const path = join(dir, file);
    const info = await stat(path).catch(() => null);
    if (info && (!newest || info.mtimeMs > newest.mtime)) {
      newest = { file: path, mtime: info.mtimeMs };
    }
  }
  return newest;
}

/**
 * Fallback only: both agents encode the project path in the directory name.
 * This is lossy for literal hyphens, so common validation later rejects mistakes.
 */
function decodeDirName(name: string, kind: SessionLogKind): string | null {
  if (kind === "pi") {
    const inner = name.replace(/^--/, "").replace(/--$/, "");
    return inner ? `/${inner.replace(/-/g, "/")}` : null;
  }
  return name.startsWith("-") ? name.replace(/-/g, "/") : null;
}
