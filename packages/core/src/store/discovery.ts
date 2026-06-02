import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FsListing, RecommendedWorkspace } from "@diffect/shared";

/** Honour $HOME first so tests can point discovery at a fixture home. */
function homeDir(): string {
  return process.env.HOME || homedir();
}

// ── Directory browser (for the add-workspace picker) ──────────────────────────

export class FsBrowseError extends Error {}

/**
 * List the sub-directories of `requested` (default: home) for an in-app folder
 * picker. Confined to the home subtree via realpath so a symlink can't escape;
 * dotfiles are hidden. Returns directories only — you register a directory as a
 * workspace, not a file.
 */
export async function listDir(requested?: string): Promise<FsListing> {
  const root = await realpath(homeDir());
  // Resolve relatives against home (not the daemon cwd); absolutes pass through.
  const target = await realpath(resolve(root, requested?.trim() || ".")).catch(
    () => null,
  );
  if (!target || !(target === root || target.startsWith(root + sep))) {
    throw new FsBrowseError("path is outside the home directory");
  }
  const dirents = await readdir(target, { withFileTypes: true }).catch(() => {
    throw new FsBrowseError("cannot read directory");
  });
  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => ({ name: d.name, path: join(target, d.name), isDir: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: target, parent: target === root ? null : dirname(target), entries };
}

// ── Recent-session recommendations ────────────────────────────────────────────

/** Captures the JSON string value of the first `"cwd": "..."` in a session log. */
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

interface Source {
  /** Directory holding one sub-directory per project. */
  root: string;
  source: RecommendedWorkspace["source"];
  /** Reject a project sub-directory by name (e.g. pi's tmp test sessions). */
  skip: (name: string) => boolean;
}

export async function recommendations(limit = 20): Promise<RecommendedWorkspace[]> {
  const home = homeDir();
  const sources: Source[] = [
    { root: join(home, ".claude", "projects"), source: "claude-code", skip: () => false },
    {
      root: join(home, ".pi", "agent", "sessions"),
      source: "pi",
      skip: (name) => /test/i.test(name),
    },
  ];
  const found = (await Promise.all(sources.map(scanSource))).flat();

  // Dedupe by resolved path, keeping the most recently active entry.
  const byPath = new Map<string, RecommendedWorkspace>();
  for (const r of found) {
    const prev = byPath.get(r.path);
    if (!prev || r.lastActiveAt > prev.lastActiveAt) byPath.set(r.path, r);
  }
  return [...byPath.values()]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, limit);
}

async function scanSource(src: Source): Promise<RecommendedWorkspace[]> {
  const dirents = await readdir(src.root, { withFileTypes: true }).catch(() => []);
  const results = await Promise.all(
    dirents.map((d) =>
      d.isDirectory() && !src.skip(d.name)
        ? projectFrom(join(src.root, d.name), d.name, src.source)
        : Promise.resolve(null),
    ),
  );
  return results.filter((r): r is RecommendedWorkspace => r !== null);
}

async function projectFrom(
  dir: string,
  dirName: string,
  source: RecommendedWorkspace["source"],
): Promise<RecommendedWorkspace | null> {
  const newest = await newestSession(dir);
  if (!newest) return null;
  const cwd = (await cwdFromSession(newest.file)) ?? decodeDirName(dirName, source);
  if (!cwd) return null;
  const path = resolve(cwd);
  if (!(await isGitRepo(path))) return null;
  return { path, name: basename(path), lastActiveAt: Math.round(newest.mtime), source };
}

async function newestSession(
  dir: string,
): Promise<{ file: string; mtime: number } | null> {
  const files = (await readdir(dir).catch(() => [])).filter((f) =>
    f.endsWith(".jsonl"),
  );
  let best: { file: string; mtime: number } | null = null;
  for (const f of files) {
    const info = await stat(join(dir, f)).catch(() => null);
    if (info && (!best || info.mtimeMs > best.mtime)) {
      best = { file: join(dir, f), mtime: info.mtimeMs };
    }
  }
  return best;
}

/** The cwd is recorded in the first session records, so read only the head. */
async function cwdFromSession(file: string): Promise<string | null> {
  const fh = await open(file, "r").catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const m = buf.toString("utf8", 0, bytesRead).match(CWD_RE);
    if (!m) return null;
    try {
      // The capture is quote-balanced but not guaranteed valid JSON (bad escapes,
      // control chars); a throw here must not sink the whole recommendations call.
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return null;
    }
  } finally {
    await fh.close();
  }
}

/**
 * Fallback only: both agents encode the project's absolute path in the directory
 * name (`/`→`-`, pi wraps in `--…--`). Lossy for paths with literal hyphens, so
 * it's a backstop when the session has no embedded cwd; the git-repo check below
 * discards a mis-decoded path.
 */
function decodeDirName(name: string, source: RecommendedWorkspace["source"]): string | null {
  if (source === "pi") {
    const inner = name.replace(/^--/, "").replace(/--$/, "");
    return inner ? `/${inner.replace(/-/g, "/")}` : null;
  }
  return name.startsWith("-") ? name.replace(/-/g, "/") : null;
}

async function isGitRepo(path: string): Promise<boolean> {
  // `.git` is a directory in a normal clone, a file in a linked worktree.
  return !!(await stat(join(path, ".git")).catch(() => null));
}
