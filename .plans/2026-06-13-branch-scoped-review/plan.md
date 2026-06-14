# Branch-scoped review — implementation plan

Status: in progress (Slices 0–2 landed; Slice 3 foundation 3.0–3.3 landed) · 2026-06-14 · branch `claude/ui-redesign-mockups-34ouhr`

Progress: **Slice 0** (show the branch) and **Slice 1** (scope-bind threads) are implemented with a build+test gate — schema bumped to v2, `ReviewScope`/`sessionId` persisted on threads, server-side scope resolution (`reviews/scope.ts`), legacy v1 threads kept in the unscoped bucket, and client filtering by the diff-stamped session. **Slice 2** (sessions as the sidebar's primary review entries) is implemented and hardened against a 24-agent adversarial review (15 confirmed findings fixed): server-derived `work` session per checked-out worktree (`workspace.ts` `deriveWorktreeSessions`), client reconstruction restricted to *worktree/branch-independent* kinds (`range`/`staged`/`unstaged`) so a session can't orphan itself after a checkout moves on, optimistic selection highlight, a debounced workspace re-derivation on `diff.changed` (no git storm), a `sessionId⇄scope` binding guard in the event log, and an unscoped-bucket nudge for first-run migration. **Slice 3** (snapshots) has landed its foundation: a per-scope content `snapshotId` is stamped on each thread at creation, carried live on the diff as `currentSnapshotId`, and surfaced as a quiet "earlier iteration" marker — verified clean by a 5-lens adversarial workflow (see *Slice 3* below). Next: the interactive session timeline (deferred 3.4) or **Slice 4** (lifecycle).

## Why

Review threads today bind to `(repo, worktree)` and nothing else — the diff *target/branch* you were reviewing under is **dropped at create time**
([daemon.ts:295-302](../../packages/core/src/daemon.ts), [shared/src/index.ts:362-374](../../packages/shared/src/index.ts)).
So a comment filed on `main..feature` is visible under *any* target for that worktree, and `git worktree remove` would strand the review of a branch whose commits still exist. Tying review to the **changeset (branch/scope)** rather than the directory is more durable — which is the instinct that kicked this off.

This is **not a new direction**: [ADR-0001](../../docs/adr/0001-review-scope-sessions.md) (Accepted 2026-06-09) already decided exactly this model — *Review Scope / Snapshot / Session* — and **explicitly rejected** the current "key threads only by repo/worktree/file/line/anchor" approach as *"too ambiguous"* (ADR:9). The code today is the rejected option. **This plan implements the accepted ADR.**

## The two axes (reconciliation)

The "should worktrees be two repos?" question conflates two different things:

- **Identity axis — the git repository.** One repo = one object store, keyed by the realpath'd `--git-common-dir` ([workspace.ts:118-153](../../packages/core/src/workspace.ts)). Two branches/worktrees are the *same* repo; the store is already keyed by it (`sha256(resolve(primaryRoot))`, [paths.ts:22-34](../../packages/core/src/store/paths.ts)). **Don't fork this.**
- **Review axis — the scope/session.** What you *review* is a changeset (a branch range, or a local working state). This is the unit comments belong to. It's a **sub-dimension of the repo**, not a separate repo.

→ The model is **"N review entries, one repo identity."** The sidebar shows reviews; they all live under one repo.

## Current state (grounded)

- **Store is already repo-keyed, not worktree-keyed.** One append-only `threads.jsonl` per repo at `<configDir>/workspaces/<sha256(primaryRoot)>/threads.jsonl`; all worktrees share it; `worktree` is just a field + a filter ([paths.ts:22-34], [daemon.ts:300-302], [refresh.ts:37-47](../../packages/core/src/reviews/refresh.ts)).
- **Threads carry no scope.** Shape is `id, repo, worktree, file, side, line, endLine, anchor, severity, status, …` — no target/scope/session ([shared/src/index.ts:262-301]). `CreateThreadRequest` has no target either.
- **Anchor base is fixed.** `anchor.baseSha` is always `resolveWorkBase()` (merge-base of defaultBranch+HEAD), independent of the target you reviewed ([daemon.ts:298-299], [anchors.ts:205-233](../../packages/core/src/reviews/anchors.ts)).
- **A worktree's current branch is surfaced nowhere** — no `--show-current`/`--abbrev-ref` exists in the codebase. `WorktreeSummary = {name, root}` only ([workspace.ts:33-38]).
- **Client** holds a transient `(repo, worktree, target)` triple ([App.tsx:34-36](../../packages/web/src/App.tsx)); `target` lives in the Topbar TargetPicker (not the Sidebar); threads are filtered client-side by `repo+worktree`, target ignored ([App.tsx:339-345]).
- `THREAD_SCHEMA_VERSION = 1`; legacy precedent already exists — null-anchor threads are kept, a schema-version gate skips unknown events, and `migrate.ts` copies-never-deletes ([anchors.ts:99-101], [event-log.ts:201](../../packages/core/src/reviews/event-log.ts), [migrate.ts:19-30](../../packages/core/src/store/migrate.ts)).

## Target model (concrete proposals for what the ADR left open)

Per ADR/CONTEXT, four layers — Scope (UI intent) → Snapshot (point-in-time git state) → Session (durable container) → Target Spec (internal git query). The ADR left the mechanics open; proposed decisions (yours to confirm — see *Decisions*):

- **Session identity** = `(repo identity, baseRef, headRef)`.
  - *Non-default branch* → auto-created PR-like session `mergeBase(defaultBranch, branchHead)..branch` (ADR:14).
  - *Default/long-lived branch or local work* → a local-state session (All local changes / Staged / Unstaged) of a worktree, **bounded**, not whole-branch history (ADR:10,15).
- **Snapshot identity** = `sha256(HEAD-sha + index-tree-hash + worktree-dirty-hash + baseRef + compareRef)`; a new snapshot when any change; threads record the snapshot they were filed against so iterations stay distinguishable (ADR:5).
- **Thread binding** = add `sessionId` (+ `snapshotId`) to `thread.created` + `Thread` + `CreateThreadRequest`. Keep `worktree` (it's the *location* for local-state sessions). Bump `THREAD_SCHEMA_VERSION` → 2.
- **Storage** = keep the per-repo log; add `session.created` / `snapshot.created` event types in it (or a sibling `sessions.jsonl`). **Do not re-key the on-disk store** — that preserves the file-watch and migration invariants ([events.ts:49-57](../../packages/core/src/events.ts), [migrate.ts]).
- **Anchor base** follows the session's base instead of the fixed work-base, so range reviews anchor correctly.

## Changes by layer

| Layer | Change |
|---|---|
| `shared/src/index.ts` | `ReviewSession`, `ReviewSnapshot` types; `sessionId`/`snapshotId` on `Thread`/`ThreadCreatedEvent`/`CreateThreadRequest`; `branch?` on `WorktreeSummary`; bump schema |
| `core/git` | current-branch resolution (`rev-parse --abbrev-ref HEAD`, detached-safe); session derivation (merge-base bounding); snapshot hashing |
| `core/reviews` | `event-log` create/replay carries session/snapshot; `anchors` uses the session base; `refresh` groups/filters by session |
| `core/daemon` | `/sessions` (reviews per repo) or extend `/workspace`; `/threads?session=`; create-thread stamps the resolved session |
| `core/store` | keep keying; add event types; migration leaves legacy threads unscoped |
| `web` | Sidebar shows repo → **reviews (sessions)** as primary entries (branch ranges + local-state), worktree shown as the checkout location; selecting a review sets repo+worktree+target together; CommentForm sends the session; `scopedThreads` filters by session; legacy/unscoped bucket |

## Slices (each ships something)

- ✅ **Slice 0 — show the branch.** Add `WorktreeSummary.branch` (one git call) and render it. No schema change; immediately answers "which branch is this checkout." Low-risk warm-up.
- ✅ **Slice 1 — scope-bind threads.** Persist a scope descriptor (target spec + resolved base/head) on threads; client sends it; bump schema; filter by it. **This is the core of the ask** — comments belong to the branch/scope, not the worktree. Old threads → unscoped, still shown.
- ✅ **Slice 2 — sessions in the sidebar.** Derive a `work` session per checked-out worktree server-side (`summarizeRepos` → `RepoSummary.sessions`); surface sessions as the sidebar's primary review entries with per-session thread counts; group threads under them by the diff-stamped `sessionId`. The client also reconstructs *stable-kind* (`range`/`staged`/`unstaged`) sessions from thread scopes and the active diff so explicit `base..compare` reviews stay reachable; `work`/`ref` reconstructions are excluded because their id depends on the live branch (would orphan after a checkout). Hardened against a 24-agent adversarial review — see *Slice 2 hardening* below.
- 🟡 **Slice 3 — snapshots & timeline.** Foundation landed (3.0–3.3): per-scope content snapshots, stamped on threads, carried on the diff, surfaced as a quiet "earlier iteration" marker. The interactive sidebar **timeline (3.4) is deferred** to a follow-up. "Outdated" stays anchor-based (decision below); the snapshot is a separate, informational iteration marker.
- **Slice 4 — lifecycle.** Default-branch bounding; complete/archive when the workspace is clean with no open threads.

For the immediate "branch-scoped comments + branch entries" goal you'd likely stop after **Slice 1 or 2**; 3–4 are the full ADR.

## Migration (non-negotiable — ADR:16)

Existing worktree-keyed threads have no session. On replay, treat missing session as **legacy/unscoped** — surfaced in a dedicated bucket under the repo, never hidden or deleted (mirrors the null-anchor + schema-version precedent). Optional back-fill: infer a session from the worktree's current branch, but default to *unscoped* to avoid wrong assignment, with a one-click "assign to this review."

## Decisions for you

1. **How far?** Slice 1 (scope-bound comments) vs Slice 2 (sidebar sessions) vs the full ADR (3–4).
2. **Local-work session granularity:** is "All local changes" of a worktree one session, or do Staged/Unstaged get their own? (ADR keeps them distinguishable via snapshots regardless.)
3. **Sidebar entries = checked-out branches (worktrees) only, or any branch (refs/heads)?** I'd start with checked-out worktrees + explicit `base..compare` reviews, not every ref.
4. **Back-fill legacy threads to a session, or leave unscoped?** I lean leave-unscoped (safe) + one-click assign.

## Slice 2 hardening (post-adversarial-review)

A 24-agent adversarial review of the first Slice-2 cut raised 20 findings; 15 confirmed. The landed fixes:

- **Reconstruction round-trip (HIGH).** A session reconstructed from a thread's stored scope re-stamps its id from the *live* branch for `work`/`ref` kinds ([reviews/scope.ts](../../packages/core/src/reviews/scope.ts) resolves `headRef` from the current branch), so an entry for a branch no longer checked out would orphan itself — the highlight never activates and it shows a *different* session's threads. Fix: client reconstruction is restricted to `STABLE_KINDS = {range, staged, unstaged}` (worktree/branch-independent identity); live `work` sessions come from the server, and the active diff is always selectable as-is ([App.tsx](../../packages/web/src/App.tsx) `extraSessions`).
- **Removed-worktree 404 (MEDIUM).** A reconstructed entry whose worktree was `git worktree remove`d would 404 the diff route (which keeps a truthy worktree). Fix: validate the carried worktree against the repo's live worktrees and fall back to the primary (`worktree=null`); stable kinds round-trip to the same id regardless, so the thread stays reachable.
- **Git storm on `diff.changed` (HIGH).** The SSE handler re-derived the whole workspace (git over every repo + worktree) on every working-tree write, with no client debounce. Fix: the diff refreshes immediately but the workspace re-derivation is coalesced to a 750ms trailing debounce (`refreshWorkspaceSoon`); `workspace` still feeds the Topbar, so it's debounced, not dropped.
- **Selection flash (MEDIUM).** Selecting a session showed the previous session's threads until the async diff landed. Fix: an optimistic `pendingSession` drives the highlight + thread filter instantly, retired the instant a fresh diff settles (safe because the round-trip fix guarantees every selectable entry re-stamps its own id).
  - **Follow-up — stranded highlight on error settle (HIGH).** The optimistic highlight was retired only by a `[diff]` effect, but `refreshDiff`'s catch path never calls `setDiff`, so a diff-route error (500 from a reconstructed range whose base ref was deleted; 404 from a removed worktree) pinned the highlight forever on a session whose diff never loads. Fix: retirement moved into `refreshDiff` itself, firing `setPendingSession(null)` in **both** the success and catch branches under the `diffSeq` last-issued-wins guard; the `[diff]` effect was removed (`setDiff` has a single call site). ([App.tsx](../../packages/web/src/App.tsx) `refreshDiff`).
  - **Follow-up — stranded highlight on no-op re-select (MEDIUM).** `selectSession` set `pendingSession` unconditionally, but the refetch was gated on `(worktree, target)` changing — so re-selecting the *already-active* session (or re-clicking a row whose diff just errored) was a setState no-op: no fetch, no settle, stranded highlight, and no way to retry a failed session by re-clicking it. Fix: a monotonic `reselectTick` bumped on every `selectSession` and added to `refreshDiff`'s deps, so every selection forces exactly one fetch (guaranteed settle) and a failed session retries on re-click. Adversarially verified across four lenses (stuck-pending / double-fetch-loop / regression / retry-correctness), no surviving defects.
- **Invisible-thread guard (LOW, defensive).** A thread with a `sessionId` but no `scope` matched neither a session view nor the unscoped bucket. Fix: the event log binds them on both write and replay — no scope ⇒ unscoped ([reviews/event-log.ts](../../packages/core/src/reviews/event-log.ts)), with a regression test.
- **First-run migration nudge (MEDIUM).** A fully-legacy repo showed an empty thread pane until the user discovered the Unscoped bucket. Fix: a non-racy hint banner ("N unscoped comments … view them") when a scoped view is empty and legacy threads exist; it never auto-flips the view.

Consciously deferred (rare/benign, noted in code): dedup of two checkouts sharing a branch name; commenting while the Unscoped bucket is open files into the active session; transient one-entry reorder after a workspace refresh (self-healing).

- **`work`/`ref` review not-currently-viewed has no sidebar entry (MEDIUM, deferred).** A `work` or `ref` review you filed comments under but aren't presently viewing gets no `SessionItem`: it's excluded from client reconstruction (its id depends on the live branch, so reconstructing it would orphan it — the round-trip fix), it isn't in the unscoped bucket (it has a scope), and the server only derives the *current* `work` session per checked-out worktree. The threads aren't lost — they're logged and counted — but the only way back to them is to re-create the same checkout/target. This is consistent with Decision #3 (sidebar = checked-out worktrees + explicit `base..compare` reviews, **not every ref**). Resolving it properly belongs to Slice 3/4 (persisted session records that survive a checkout move), not a client reconstruction hack.

## Slice 3 — snapshots (foundation 3.0–3.3, verified)

Two confirmed decisions shaped the scope:

- **"Outdated" stays anchor-based.** A thread is *outdated* iff its anchor failed to re-anchor (`anchorState === "stale"` — the commented code moved or vanished). The new `snapshotId` is a **separate, quieter signal**: "filed in an earlier iteration of this review." It never hides, filters, resolves, reorders, or closes a thread. Treating a snapshot mismatch as "outdated" would flag *every* thread the moment the worktree changes — pure noise.
- **Scope this pass = foundation + marker.** Ship the snapshot identity, the stamping, the live carry, and the read-only marker. **Defer** the interactive sidebar timeline (3.4).

What landed:

- **3.0 — snapshot identity ([reviews/scope.ts](../../packages/core/src/reviews/scope.ts) `snapshotIdForState`).** `snap_${sha256(HEAD-sha · staged-tree (write-tree) · sha256(unstaged git-diff) · sha256(untracked, work-kind only) · baseRef · headRef)[:16]}`. Content-sensitive (exact staged *and* unstaged content, not just `git status --porcelain`), refs in the hash so two scopes over identical state differ, freeform components nested-hashed to fixed width so a `|` inside content can't collide. **Side-effect-free** (`write-tree` writes a tree object but mutates no index/HEAD/ref/user-visible state) and **null on unborn HEAD**. Untracked files count only for the `work` kind. 5 unit tests ([scope.test.ts](../../packages/core/test/scope.test.ts)).
- **3.1 — stamp on `thread.created` ([event-log.ts](../../packages/core/src/reviews/event-log.ts)).** `snapshotId` is bound to scope on **both** write and replay (no scope ⇒ `snapshotId` null, mirroring the `sessionId` orphan guard — an unscoped id is invisible everywhere). **No schema bump:** it rides as an optional field inside v2. Bumping to v3 would be *worse* — v2-only readers would reject v3 events and hide snapshot-stamped threads; older readers ignoring an unknown optional field is the desired back-compat. Round-trip + orphan-coercion tests extended.
- **3.2 — carry on the diff.** `RepoDiff.currentSnapshotId?: string`; the daemon diff route stamps it `?? undefined` so unborn HEAD **omits** the field rather than emitting JSON null. Every scoped-thread create path (daemon route, CLI `cmdComment`/`cmdGeneral`) stamps `snapshotId` in lockstep with `sessionId`; `snapshotId` is always server/CLI-derived, never client input.
- **3.3 — "earlier iteration" marker ([ThreadConversation.tsx](../../packages/web/src/components/ThreadConversation.tsx)).** Renders iff `thread.snapshotId && currentSnapshotId && thread.snapshotId !== currentSnapshotId`. Delivered via a minimal [`CurrentSnapshotContext`](../../packages/web/src/currentSnapshot.ts) provided once around the diff/thread panes — chosen over prop-drilling because the value is constant for the whole view and the consumer is one shared leaf reached through DiffView's memoized render-extension callbacks → `InlineThread`, the out-of-diff preview, and the thread list (drilling would have churned 6+ signatures including a perf-sensitive `useCallback` dependency array; the context is the codebase's first, justified by exactly that shape). Styled deliberately quiet (`.iteration-badge`: muted, lowercase, no card accent stripe) so it never competes with the orange/uppercase `.stale-badge`.

**Verification.** Build green (shared → core → web `tsc -b`); 135 core tests pass. A 5-lens adversarial workflow — snapshot determinism/side-effects, no-bump back-compat + orphan coercion, daemon/CLI/event-log stamp lockstep, marker correctness + provider coverage, edge-case degradation (unborn/detached HEAD) — each finding refuted by two independent skeptics under a unanimous-survival gate: **zero surviving defects**.

Deferred to a follow-up (3.4 / Slice 4): the interactive sidebar timeline of snapshots, and persisted session records so a snapshot-stamped review survives a checkout move (ties into the *"`work`/`ref` review not-currently-viewed"* gap above).

## Risks

- **Migration correctness** — don't strand or duplicate existing threads.
- **Local-state caveat** — work/staged/unstaged are per-worktree dirty state; sessions must accommodate both range-based and local-state scopes (don't force everything into a branch range).
- **Scope creep** — the full Session/Snapshot/timeline is sizeable; Slices 0–1 deliver the core ask cheaply.
