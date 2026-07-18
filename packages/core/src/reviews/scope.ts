import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ReviewScope, ReviewTarget } from "@diffect/shared";
import { gitTry } from "../git/exec.js";
import {
  resolveCurrentBranch,
  resolveDefaultBranch,
  resolveWorkBase,
} from "../git/diff.js";
import { normalizeTarget } from "../git/target.js";

/**
 * Resolve the review scope a thread filed against `target` in `treeRoot` belongs
 * to. The scope captures both a *symbolic* identity (baseRef/headRef → a stable
 * sessionId) and the *resolved* base commit the anchor's "old" side reads from.
 *
 * `worktree` is the URL-safe checkout name (null for the primary). It names a
 * detached `work` head and is also part of the canonical session identity, so
 * identical refs reviewed in different checkouts never share comments.
 */
export async function resolveScope(
  treeRoot: string,
  target: ReviewTarget,
  worktree: string | null,
): Promise<ReviewScope> {
  const branch = await resolveCurrentBranch(treeRoot);
  const { baseRef, headRef, baseSha } = await resolveRefs(
    treeRoot,
    target,
    branch,
    worktree,
  );
  return { target: target.spec, kind: target.kind, baseRef, headRef, baseSha, branch };
}

/**
 * Per-kind base/head identity + anchoring base. The symbolic refs are chosen so
 * the session stays stable as commits advance (a feature branch reviewed against
 * `main` keeps one identity even as its merge-base SHA moves); the `baseSha` is
 * the commit the "old" side of the diff — and thus the anchor — reads from.
 */
async function resolveRefs(
  treeRoot: string,
  target: ReviewTarget,
  branch: string | null,
  worktree: string | null,
): Promise<{ baseRef: string; headRef: string; baseSha: string | null }> {
  switch (target.kind) {
    case "work": {
      // Branch vs its merge-base with the default branch — the PR-like session.
      const defaultBranch = await resolveDefaultBranch(treeRoot);
      return {
        baseRef: defaultBranch ?? "HEAD",
        headRef: branch ?? `wt:${worktree ?? basename(treeRoot)}`,
        baseSha: await resolveWorkBase(treeRoot),
      };
    }
    case "staged":
      // Index vs HEAD: the "old" side is HEAD.
      return { baseRef: "HEAD", headRef: "index", baseSha: await revParse(treeRoot, "HEAD") };
    case "unstaged":
      // Worktree vs index: the index has no commit sha, so anchor "old" against
      // HEAD (the nearest stable commit) — a best-effort base for local edits.
      return { baseRef: "index", headRef: "worktree", baseSha: await revParse(treeRoot, "HEAD") };
    case "ref":
      // <ref> vs worktree: the "old" side is the ref itself.
      return {
        baseRef: target.from!,
        headRef: branch ?? "worktree",
        baseSha: await revParse(treeRoot, target.from!),
      };
    case "range":
      // <from>..<to>: the "old" side is `from`.
      return {
        baseRef: target.from!,
        headRef: target.to!,
        baseSha: await revParse(treeRoot, target.from!),
      };
  }
}

/**
 * Resolve a ref to its commit sha, or null when it doesn't exist. `--verify`
 * keeps the output to the single resolved sha (a bare `rev-parse <ref>` echoes
 * option-like args back); `--quiet` makes a miss exit non-zero silently; and
 * `--end-of-options` forces a ref starting with `-` to be parsed as a rev rather
 * than a flag (argument-injection guard for user-supplied range/ref specs).
 */
function revParse(repoRoot: string, ref: string): Promise<string | null> {
  return gitTry(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref]);
}

/**
 * Canonical id of the review session a scope belongs to. It uses only symbolic
 * identity, normalized range semantics, and checkout — never resolved commits
 * or snapshots — so refs may advance without moving their existing comments.
 */
export function sessionIdForScope(
  scope: ReviewScope,
  worktree: string | null,
): string {
  const rangeSemantics = rangeSemanticsForScope(scope) ?? "not-range";
  const normalizedWorktree = worktree === "" ? null : worktree;
  return hashSessionIdentity([
    "v2",
    scope.kind,
    rangeSemantics,
    scope.baseRef,
    scope.headRef,
    normalizedWorktree === null ? "primary" : "linked",
    normalizedWorktree ?? "",
  ]);
}

/** Normalized range behavior carried separately from the raw persisted target. */
export function rangeSemanticsForScope(
  scope: ReviewScope,
): "direct" | "merge-base" | null {
  if (scope.kind !== "range") return null;
  return normalizeTarget(scope.target).threeDot === true
    ? "merge-base"
    : "direct";
}

/**
 * The pre-canonical kind/base/head id. Readers accept it as a lookup alias so
 * old links keep working, but replay projects scoped threads to the canonical
 * checkout- and range-aware id instead of rewriting the append-only log.
 */
export function legacySessionIdForScope(scope: ReviewScope): string {
  return hashSessionIdentity([scope.kind, scope.baseRef, scope.headRef]);
}

function hashSessionIdentity(parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
  return `sess_${h.slice(0, 16)}`;
}

/**
 * Fingerprint the point-in-time git state a thread is (or would be) filed
 * against — the "snapshot" of ADR-0001's Scope → Snapshot → Session model
 * ([docs/adr/0001-review-scope-sessions.md]). It folds HEAD, the staged tree,
 * and the unstaged working-tree changes (plus untracked files for the `work`
 * kind, the only diff that shows them) under the scope's symbolic refs, so a
 * snapshot belongs to exactly one review.
 *
 * It is *informational*: a thread records which iteration it was filed under, so
 * a later snapshot means the thread predates the current state. It is NOT the
 * "outdated" signal — that stays the anchor system's `anchorState` (a comment
 * whose code merely moved is not outdated), so coarseness here is harmless.
 *
 * Side-effect-free w.r.t. the index, worktree, and refs: `write-tree` only adds
 * content-addressed tree objects (idempotent for a stable index). All four git
 * calls run concurrently. Returns null when there's no commit to anchor against
 * (unborn HEAD) so thread creation never breaks when a snapshot can't be
 * computed — the thread is simply unscoped-in-time.
 */
export async function snapshotIdForState(
  treeRoot: string,
  scope: ReviewScope,
): Promise<string | null> {
  const headSha = await gitTry(treeRoot, ["rev-parse", "HEAD"]);
  if (headSha === null) return null; // unborn/empty HEAD — nothing to anchor to
  const [indexTree, worktreeDiff, untracked] = await Promise.all([
    // Staged content, exact (null on an unmerged index — fold to empty, still deterministic).
    gitTry(treeRoot, ["write-tree"]),
    // Unstaged content (worktree vs index). Captures edits the status letters alone miss.
    gitTry(treeRoot, ["diff"]),
    // Untracked files only matter to the `work` diff (the only kind that surfaces them).
    scope.kind === "work"
      ? gitTry(treeRoot, ["ls-files", "--others", "--exclude-standard"])
      : Promise.resolve(""),
  ]);
  // Nest-hash the freeform components (diff/untracked) to fixed-width hex so the
  // `|` join can't be ambiguated by content that contains the delimiter.
  const h = createHash("sha256")
    .update(
      [
        headSha,
        indexTree ?? "",
        sha256(worktreeDiff ?? ""),
        sha256(untracked ?? ""),
        scope.baseRef,
        scope.headRef,
      ].join("|"),
      "utf8",
    )
    .digest("hex");
  return `snap_${h.slice(0, 16)}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
