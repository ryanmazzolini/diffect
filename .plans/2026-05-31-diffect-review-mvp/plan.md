---
source: diffective
date: 2026-05-31
type: slice-plan
goal: A reviewer can review a local workspace diff in Diffect, leave durable comments, and let an agent consume and resolve them without GitHub, a database, or daemon-owned automation.
---

# Diffect Review MVP

**Status**: planned
**Workflow**: `.plans/2026-05-31-diffect-review-mvp/`

## Goal

A reviewer can open a local workspace diff, leave durable anchored feedback, and hand that feedback to an agent through the same `.reviews/` state the browser uses.

## Acceptance Criteria

- Running `diffectd --workspace <path>` opens a local browser review for the default `work` target and shows changed files/hunks from at least one Git repo, including committed-since-base, unstaged, and untracked work.
- A user can create inline and general review threads from the browser; thread events are appended to `<workspace>/.reviews/threads.jsonl`.
- With `diffectd` stopped, `diffect list --status open --json` returns the same open threads; `diffect reply`, `diffect resolve`, and `diffect dismiss` append normal events and replay correctly.
- After reviewed files change, threads whose selected text/context still exists remain active; threads whose anchor cannot be found are shown as stale/outdated and are never silently deleted.
- A workspace review can cover multiple repos/worktrees and can normalize target specs for `work`, `staged`, `unstaged`, and branch/range comparisons.
- The browser review loop supports live refresh from worktree or `.reviews/` changes and can hand off a file:line to the user's configured editor.
- The MVP does not include automatic AI review, guided tours, GitHub sync, profile/database storage, or daemon-owned apply orchestration.

## Slice Plan

### Slice 1 — First durable workspace comment  [first: high value, low commitment]

Tracer bullet: In a temporary single-repo workspace, run `diffectd --workspace <dir>`, open the browser, see the default `work` diff, create one inline thread, stop the daemon, and confirm `diffect list --json` reads that thread from `.reviews/threads.jsonl`.

Tasks:
- [project shell]: Bootstrap the minimal CLI + daemon + web project structure (`package.json`, `tsconfig.json`, `src/cli.ts`, `src/daemon.ts`, `src/git/`, `src/reviews/`, `web/`).
- [workspace discovery]: Implement single-repo workspace discovery and stable repo-relative paths.
- [target resolution]: Implement the default `work` target in `src/git/diff.ts`: committed-since-base plus unstaged and untracked files.
- [thread event log]: Implement `thread.created` append and replay in `src/reviews/event-log.ts`; create `.reviews/threads.jsonl` on first write.
- [daemon API]: Implement `GET /workspace`, `GET /repos/:repo/diff`, `GET /threads`, and `POST /threads` as thin wrappers over git diff + the event log.
- [browser review UI]: Render changed files/hunks, an inline comment form, and the open thread list.
- [CLI/agent surface]: Implement `diffect list --status open --json` against the file store, not the daemon.

Verification: Automated fixture repo test for diff + event replay, plus a manual browser-to-CLI round trip with the daemon stopped before `diffect list`.
Ships: A reviewer can leave the first durable inline comment on `work`, and an agent can read it without the daemon.
Covers: AC1, AC2, AC7; partially covers AC3.

### Slice 2 — Human-to-agent fix loop

Tracer bullet: A reviewer leaves a thread, an agent lists it from the CLI, replies after making a fix, resolves or dismisses it, and the browser shows the updated conversation/status.

Tasks:
- [event model]: Add `comment.added`, `thread.resolved`, and `thread.dismissed` events with deterministic replay and schema-version validation.
- [CLI/agent surface]: Add `diffect diff`, `diffect comment`, `diffect general`, `diffect reply`, `diffect resolve`, and `diffect dismiss`; keep JSON output stable for skills/extensions.
- [agent integration]: Add first pi/agent integration notes or skill scaffold under `integrations/pi/` that teaches agents to list, reply, resolve, dismiss, and create normal review threads.
- [daemon API]: Add `POST /threads/:id/comments`, `POST /threads/:id/resolve`, and `POST /threads/:id/dismiss` as event-log writes.
- [browser review UI]: Add reply, resolve, dismiss, severity, and status-filter controls.
- [verification fixtures]: Cover daemon-down CLI writes and daemon-visible replay after restart.

Verification: End-to-end test that writes a human thread, appends an agent reply, resolves it with the CLI, restarts `diffectd`, and sees the resolved status in the browser/API.
Ships: The core human feedback → agent fix → human verification loop works without `apply` orchestration.
Covers: AC3, AC7.

### Slice 3 — Comments survive changed code

Tracer bullet: After an agent edits a reviewed file, a thread on a moved-but-still-present range remains active; a thread whose range is removed becomes stale/outdated instead of disappearing.

Tasks:
- [anchor model]: Persist side, line, endLine, file hash, anchor/context hash, and hunk snippet on `thread.created` events.
- [re-anchoring]: Implement current-line lookup, then context/snippet lookup, then stale/outdated fallback in `src/reviews/anchors.ts`.
- [diff refresh]: Recompute thread positions against the current `work` diff when loading threads.
- [browser review UI]: Show active vs stale/outdated states clearly and keep stale unresolved feedback reachable from the review path.
- [CLI/agent surface]: Include anchor/stale state in `diffect list --json` so agents do not lose unresolved feedback.
- [verification fixtures]: Add cases for moved ranges, nearby formatting changes, deleted ranges, and whole-file hash changes that should not invalidate surviving anchors.

Verification: Fixture tests prove surviving anchors stay active and deleted anchors become stale; manual browser check shows stale threads rather than dropping them.
Ships: Review comments remain trustworthy across normal fix iterations.
Covers: AC4.

### Slice 4 — Workspace targets, not session management

Tracer bullet: In a workspace with two repos and two worktrees for one repo, `diffect work` and the browser show grouped changes; `staged`, `unstaged`, and `main..feature` normalize to distinct internal review targets without requiring the user to manage sessions.

Tasks:
- [workspace discovery]: Walk workspace depth 1-2 for git roots, detect `.git` dir vs `.git` file, and group worktrees by shared git common-dir.
- [target resolution]: Normalize `work`, `staged`, `unstaged`, single refs, and ref ranges into one internal review-target shape.
- [review state]: Attach normalized target metadata to thread events and replay filters; use `.reviews/state.json` only for workspace metadata/cursors, not as the thread source of truth.
- [daemon API]: Add target/worktree filters to workspace, diff, and thread endpoints while keeping cross-repo defaults.
- [CLI/agent surface]: Accept target specs on `diffect diff`, `diffect list`, and comment creation commands.
- [browser review UI]: Add repo/worktree grouping and a target selector that defaults to `work`.

Verification: Multi-repo/worktree fixture covers discovery, target normalization, event filtering, and browser/API grouping.
Ships: Diffect works on a real workspace slice rather than a single checkout, while staying target-first.
Covers: AC5.

### Slice 5 — Fast browser review ergonomics

Tracer bullet: A reviewer opens a thread in the browser, jumps to the file in their editor, saves a fix, and the browser updates the diff/thread state without a manual reload.

Tasks:
- [watchers/events]: Watch worktrees and `.reviews/`; emit `diff.changed`, `thread.added`, and `thread.updated` over `GET /events` with safe debouncing.
- [browser review UI]: Subscribe to SSE, refresh changed diff/thread panels, and preserve reviewer scroll/selection where possible.
- [editor handoff]: Implement `POST /open` plus host editor detection for at least VS Code/Cursor/Zed/JetBrains local commands.
- [review navigation]: Add cross-repo inbox, severity/status filters, general threads, and stale-thread access points.
- [package/docs]: Document quickstart, `.reviews/` visibility choices, default localhost binding, and the intentionally deferred AI/tour/apply features.

Verification: Manual local review loop from browser → editor → save → SSE refresh; automated API test for event emission when `.reviews/threads.jsonl` changes.
Ships: The browser loop is fast enough for day-to-day human review.
Covers: AC6, AC7.

## Deferred

- Automatic AI review pass — defer until human review ergonomics and the agent fix loop are excellent; later AI findings should create normal review threads.
- Guided tours — defer until reviews are primary and reliable; tours should be a read-only explanatory add-on, not a feedback system.
- Daemon-owned `apply` orchestration — defer in favor of Diffity-style skills/extensions that call stable CLI commands.
- GitHub sync/mirroring — defer; MVP may detect/link PRs later, but `.reviews/` remains canonical.
- Remote auth beyond trusted local/Tailscale use — defer token/auth design until the remote exposure model is real.
- Structural/noise diff classification — defer until the plain diff/thread loop is useful.
- Explicit user-managed review sessions — defer indefinitely unless target-first review state proves insufficient.

## Notes

- This plan assumes a first implementation in Node/TypeScript because the product needs a CLI, HTTP/SSE daemon, browser UI, and installable public package. Revisit before Slice 1 if that assumption is wrong.
- `.reviews/threads.jsonl` is the canonical thread store. Generated caches are allowed later, but not as source of truth.
- Review Target Specs are user-facing; Review Sessions remain internal durable records.
- No `question.md` exists yet; this plan is based on `CONTEXT.md`, `review-core-api.md`, and the aligned decisions from the planning conversation.
