import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  FileStatus,
  RepoDiff,
} from "@diffect/shared";
import { git, gitTry } from "./exec.js";

/**
 * Resolve the base ref the `work` target diffs against: the merge-base of the
 * repo's default branch and HEAD. Falls back to HEAD when no default branch is
 * discoverable (e.g. a fresh repo with no remote).
 */
export async function resolveWorkBase(repoRoot: string): Promise<string | null> {
  const defaultBranch = await resolveDefaultBranch(repoRoot);
  if (defaultBranch) {
    const mergeBase = await gitTry(repoRoot, [
      "merge-base",
      defaultBranch,
      "HEAD",
    ]);
    if (mergeBase) return mergeBase;
  }
  // No default branch (or no merge-base): diff against HEAD if it exists.
  return await gitTry(repoRoot, ["rev-parse", "HEAD"]);
}

/**
 * The branch currently checked out in a worktree, or null when HEAD is detached.
 * `symbolic-ref --short HEAD` prints the short branch name and exits non-zero
 * (→ gitTry null) on a detached HEAD, so a detached checkout reads as "no branch".
 */
export async function resolveCurrentBranch(
  repoRoot: string,
): Promise<string | null> {
  return await gitTry(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

export async function resolveDefaultBranch(
  repoRoot: string,
): Promise<string | null> {
  // origin/HEAD points at the remote default branch when a remote is set up.
  const originHead = await gitTry(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead) return originHead.replace(/^refs\//, "");

  // Fall back to a local main/master if present.
  for (const candidate of ["main", "master"]) {
    const sha = await gitTry(repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      candidate,
    ]);
    if (sha) return candidate;
  }
  return null;
}

/**
 * Compute the `work` target diff for a repo: everything changed for the slice,
 * meaning committed-since-base + unstaged + untracked. We diff the working tree
 * against the base ref (which captures committed and unstaged changes in one
 * pass) and then append untracked files as synthetic all-added diffs.
 */
export interface WorktreeDiffOptions {
  includeIgnored?: boolean;
}

export async function computeWorkDiff(
  repoRoot: string,
  options: WorktreeDiffOptions = {},
): Promise<RepoDiff> {
  const base = await resolveWorkBase(repoRoot);

  const tracked = base
    ? await diffAgainst(repoRoot, base)
    : // No commits yet: nothing is tracked, so all content shows as untracked.
      [];

  const untrackedDiffs = await syntheticUntrackedDiffs(repoRoot, options);

  // `repo`/`worktree` are stamped by the caller (daemon/CLI) that knows the
  // workspace identity; the git layer only produces target + files.
  return { target: "work", files: [...tracked, ...untrackedDiffs] };
}

/** Build synthetic all-added diffs for every visible untracked file. */
export async function syntheticUntrackedDiffs(
  repoRoot: string,
  options: WorktreeDiffOptions = {},
): Promise<DiffFile[]> {
  const untracked = await untrackedFiles(repoRoot, options);
  const diffs = await Promise.all(
    untracked.map((path) => syntheticAddedFile(repoRoot, path)),
  );
  return markIgnored(repoRoot, diffs.filter((f): f is DiffFile => !!f));
}

/**
 * Run `git diff` with Diffect's canonical flags and parse the unified output.
 * The flags are correctness-load-bearing — core.quotePath=false keeps non-ASCII
 * paths literal, and rename/copy detection feeds the parser — so every diff in
 * the app goes through here rather than re-listing them.
 */
export async function gitDiff(
  repoRoot: string,
  args: string[],
): Promise<DiffFile[]> {
  const { stdout } = await git(repoRoot, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--find-copies",
    ...args,
    "--",
  ]);
  return markIgnored(repoRoot, parseUnifiedDiff(stdout));
}

async function markIgnored(repoRoot: string, files: DiffFile[]): Promise<DiffFile[]> {
  if (files.length === 0) return files;
  const paths = files.flatMap((file) =>
    file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path],
  );
  let ignored: Set<string>;
  try {
    const { stdout } = await git(repoRoot, [
      "check-ignore",
      "--no-index",
      "--",
      ...paths,
    ]);
    ignored = new Set(stdout.split("\n").filter(Boolean));
  } catch {
    ignored = new Set();
  }
  if (ignored.size === 0) return files;
  return files.map((file) =>
    ignored.has(file.path) || (file.oldPath ? ignored.has(file.oldPath) : false)
      ? { ...file, ignored: true }
      : file,
  );
}

function diffAgainst(repoRoot: string, base: string): Promise<DiffFile[]> {
  // base..worktree: no --cached, so unstaged changes are included, and base is a
  // commit, so committed-since-base is included too.
  return gitDiff(repoRoot, [base]);
}

async function untrackedFiles(
  repoRoot: string,
  options: WorktreeDiffOptions,
): Promise<string[]> {
  const visible = await git(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const ignored = options.includeIgnored ? await ignoredUntrackedFiles(repoRoot) : [];
  return [...new Set([...lines(visible.stdout), ...ignored])]
    .filter(Boolean)
    .filter((p) => !isReviewStorePath(p));
}

export async function ignoredUntrackedFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await git(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
  ]);
  return lines(stdout).filter(isReviewableIgnoredPath).slice(0, 500);
}

function lines(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Diffect's own review store lives in `.reviews/`. When it's not gitignored it
 * would otherwise surface as untracked "code" in the work diff — never show it.
 */
function isReviewStorePath(path: string): boolean {
  return path === ".reviews" || path.startsWith(".reviews/");
}

function isReviewableIgnoredPath(path: string): boolean {
  if (isReviewStorePath(path)) return false;
  const parts = path.split("/");
  return !parts.some((part) =>
    [".git", "node_modules", ".next", "dist", "build", "coverage", "target"].includes(part),
  );
}

async function syntheticAddedFile(
  repoRoot: string,
  path: string,
): Promise<DiffFile | null> {
  let content: string;
  try {
    content = await readFile(join(repoRoot, path), "utf8");
  } catch {
    return null; // disappeared or unreadable
  }
  if (content.includes("\0")) return null; // skip binary
  const endsWithNewline = content.endsWith("\n");
  const rawLines = content.split("\n");
  // A trailing newline yields a final empty element; drop it for line counting.
  if (endsWithNewline && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  const lines: DiffLine[] = rawLines.map((text, i) => ({
    type: "add",
    old: null,
    new: i + 1,
    text,
  }));
  // Mirror git: a file with no trailing newline carries the marker on its last line.
  const last = lines[lines.length - 1];
  if (last && content && !endsWithNewline) last.noNewline = true;
  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines,
  };
  return {
    path,
    status: "untracked",
    additions: lines.length,
    deletions: 0,
    hunks: lines.length ? [hunk] : [],
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `git diff` unified output into structured files/hunks/lines. */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const pushFile = () => {
    if (current) {
      if (hunk) current.hunks.push(hunk);
      files.push(current);
    }
    current = null;
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushFile();
      current = {
        path: "",
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = unquotePath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = unquotePath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("copy from ")) {
      current.status = "renamed"; // display a copy like a rename
      current.oldPath = unquotePath(line.slice("copy from ".length));
      continue;
    }
    if (line.startsWith("copy to ")) {
      current.path = unquotePath(line.slice("copy to ".length));
      continue;
    }
    if (line.startsWith("--- ")) {
      // Old side is prefixed `a/`; strip exactly that, not a generic [ab]/ that
      // would corrupt a real top-level dir literally named `a`.
      const p = stripDiffPath(line.slice(4), "a/");
      if (p && !current.oldPath && p !== "/dev/null") current.oldPath = p;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = stripDiffPath(line.slice(4), "b/");
      if (p && p !== "/dev/null") current.path = p;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      if (hunk) current.hunks.push(hunk);
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      hunk = {
        header: line,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", old: null, new: newLine++, text: line.slice(1) });
      current.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", old: oldLine++, new: null, text: line.slice(1) });
      current.deletions++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({
        type: "context",
        old: oldLine++,
        new: newLine++,
        text: line.slice(1),
      });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" applies to the line just emitted; record it
      // so toFullDiff can round-trip the marker. Without it the renderer treats
      // every EOF line as un-terminated and its content check mismatches.
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
  }
  pushFile();

  // Drop empty shells (mode-only changes with no path) and normalize deletes.
  return files.filter((f) => f.path || f.oldPath).map(normalizeStatus);
}

function normalizeStatus(f: DiffFile): DiffFile {
  if (!f.path && f.oldPath) {
    // Deleted file: +++ was /dev/null, so path stayed empty.
    return {
      ...f,
      path: f.oldPath,
      status: f.status === "modified" ? "deleted" : f.status,
    };
  }
  return f;
}

/**
 * Strip the side-specific (`a/` or `b/`) prefix git adds to diff paths. The
 * prefix is passed explicitly so a real top-level directory literally named `a`
 * or `b` is not corrupted. Also drops git's optional trailing tab and unquotes
 * C-quoted paths.
 */
function stripDiffPath(p: string, prefix: "a/" | "b/"): string {
  // git may append a tab + timestamp on `---`/`+++` lines.
  const trimmed = unquotePath(p.replace(/\t.*$/, "").trim());
  if (trimmed === "/dev/null") return trimmed;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

/**
 * Reverse git's C-style path quoting. Git wraps a path in double quotes and
 * backslash-escapes special bytes when it can't print it literally; with
 * core.quotePath=false this is rare, but quotes/control chars still trigger it.
 */
function unquotePath(p: string): string {
  const s = p.trim();
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const inner = s.slice(1, -1);
  // Decode into a byte array, then UTF-8 decode the whole thing — octal/hex
  // escapes are individual bytes of a multi-byte sequence (e.g. \303\251 = é),
  // so they must be reassembled before decoding, not turned into chars one by one.
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = inner[++i]!;
    if (next === "n") bytes.push(0x0a);
    else if (next === "t") bytes.push(0x09);
    else if (next === "r") bytes.push(0x0d);
    else if (next === '"') bytes.push(0x22);
    else if (next === "\\") bytes.push(0x5c);
    else if (next === "x") {
      bytes.push(parseInt(inner.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (next >= "0" && next <= "7") {
      let oct = next;
      let peek = inner[i + 1];
      while (oct.length < 3 && peek !== undefined && peek >= "0" && peek <= "7") {
        oct += peek;
        i++;
        peek = inner[i + 1];
      }
      bytes.push(parseInt(oct, 8));
    } else {
      for (const b of Buffer.from(next, "utf8")) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export type { FileStatus };
