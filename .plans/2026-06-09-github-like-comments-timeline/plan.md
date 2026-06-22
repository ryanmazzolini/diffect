---
source: diffect
date: 2026-06-09
type: slice-plan
goal: Replace the right comments pane with a GitHub-like Conversation timeline while preserving inline review comments and making comment identity unambiguous across review scopes and snapshots.
---

# GitHub-like Comments Timeline

**Status**: planned
**Workflow**: `.plans/2026-06-09-github-like-comments-timeline/`

## Goal

Give review threads a wide GitHub-like Conversation surface that interleaves comments and commits, while keeping inline diff comments anchored and distinguishable across All/Staged/Unstaged/base-compare review states.

## Acceptance Criteria

- The main content has a tab or equivalent control that switches between the Diff view and a Conversation timeline.
- The Diff view still renders inline review threads at their anchored file lines and supports creating/replying/resolving from the diff.
- The persistent right comments pane is removed or no longer needed for normal thread browsing.
- The Conversation timeline shows one card per Review Thread in a wide central layout with file path, line range, code context, comments, reply controls, and resolve controls.
- Commit entries for the active review scope appear in the Conversation timeline in timestamp order with review thread activity.
- Adding a new commit after a comment makes that commit visible later in the Conversation history after refresh/live update.
- Review Threads created in Staged/Unstaged/All local changes retain the Review Scope Snapshot they were created against, including enough git-state identity to distinguish different HEAD/index/worktree states.
- On a non-default branch, the Conversation timeline automatically includes the branch session bounded by its fork point/merge-base with the default branch.
- On the default branch, Conversation history is bounded by an active Review Session rather than the whole branch, and the session completes/archives once the workspace is clean and no open threads remain.
- Open/closed/all filtering remains available from the Conversation surface.

## Slice Plan

### Slice 1 — Thread scope snapshot tracer

Tracer bullet: creating a new inline comment carries the selected Review Scope through the web client, daemon, event log, replay, and thread UI as a durable Review Scope Snapshot; legacy threads still render as legacy/unscoped.

Tasks:
- Shared contract (`packages/shared/src/index.ts`): add Review Scope, Review Scope Snapshot, and `sessionId`/`scopeSnapshot` fields to thread creation events and replayed `Thread`; keep fields optional for legacy events.
- Core git/session (`packages/core/src/git/*`, new or existing `packages/core/src/reviews/*`): add minimal snapshot resolution for `work`, `staged`, `unstaged`, and base/compare target specs with `headSha`, index identity where available, worktree fingerprint placeholder/initial implementation, and resolved base/compare SHAs.
- Core event log (`packages/core/src/reviews/event-log.ts`): persist snapshot/session metadata on `thread.created`, replay it onto `Thread`, and continue loading old logs without metadata.
- Daemon/API (`packages/core/src/daemon.ts`): accept the active target/review-scope on `POST /threads`, resolve the snapshot before `createThread`, and use the selected scope rather than always anchoring from `resolveWorkBase(...)` where that matters.
- Web creation path (`packages/web/src/App.tsx`, `packages/web/src/components/DiffView.tsx`, `packages/web/src/components/CommentForm.tsx`): pass the active target from App to comment creation.
- Web thread rendering (`packages/web/src/components/ThreadConversation.tsx` or `ThreadList.tsx`): show a compact scope/snapshot or legacy/unscoped badge so the tracer is visible.
- Tests (`packages/core/test/event-log.test.ts`, `packages/core/test/target.test.ts`, relevant web/e2e coverage): cover replay of legacy and new events plus creating scoped threads from local modes.

Verification: create comments in All/Staged/Unstaged and confirm returned threads include distinct snapshot metadata; legacy fixture events still load; inline comments still render and can be replied to/resolved.
Ships: newly created comments are no longer ambiguous across selected review modes/snapshots, even before the Conversation tab exists.
Covers: snapshot identity, inline comments preserved, legacy visibility assumption.

### Slice 2 — Central Conversation tab for threads

Tracer bullet: the main workbench can switch between Diff and Conversation, and Conversation displays one wide card per Review Thread using existing reply/resolve/open controls.

Tasks:
- Web app state/layout (`packages/web/src/App.tsx`): introduce a main view state (`diff`/`conversation`), remove the right thread pane from normal browsing, and keep the left sidebar + diff pane behavior intact.
- Conversation component (new `packages/web/src/components/ConversationTimeline.tsx` or reuse/rename `ThreadList.tsx`): render filtered thread cards in central layout with file path, line/range, status, scope/legacy badge, comments, reply, close, delete, and open-in-editor controls via `ThreadConversation`.
- Filtering (`packages/web/src/App.tsx`): move open/closed/all filter controls from the right pane into the Conversation surface, with counts from scoped threads.
- Styling (`packages/web/src/styles.css`): add tab bar/timeline/card styles, remove or de-emphasize `.thread-pane` layout dependency, and preserve responsive behavior.
- E2E/UI tests (`packages/e2e/tests/layout.spec.ts`, `packages/e2e/tests/review.spec.ts` or new conversation spec): verify tab switching, no normal right pane dependency, filtering, reply/resolve from Conversation, and inline diff threads still work.

Verification: manually and/or e2e create an inline comment, switch to Conversation, reply/close it there, switch back to Diff, and see the inline thread updated at its anchor.
Ships: users can browse and manage review threads in the wide middle surface without sacrificing diff width to a permanent comments sidebar.
Covers: Diff/Conversation tabs, right pane removal, one-card-per-thread timeline, filtering, inline comments preserved.

### Slice 3 — Timeline API with commit interleaving

Tracer bullet: Conversation receives a single ordered timeline containing one item per Review Thread plus commit items for the active review scope/session.

Tasks:
- Shared contract (`packages/shared/src/index.ts`): add `ConversationTimeline`, `TimelineItem`, `ThreadTimelineItem`, and `CommitTimelineItem` types with commit SHA, subject, author, timestamp, and ordering timestamp.
- Core git history (`packages/core/src/git/refs.ts` or new `packages/core/src/git/history.ts`): expose commit listing for a resolved scope/session range with author/timestamp metadata, not just SHA/subject picker data.
- Core timeline assembly (`packages/core/src/reviews/*`): combine refreshed threads and commit history into timestamp-ordered timeline items; sort thread cards by creation/update decision from `question.md` while keeping one card per thread.
- Daemon route (`packages/core/src/daemon.ts`): add `GET /repos/:repo/timeline?worktree=&target=` or equivalent session-aware route.
- Web API (`packages/web/src/api.ts`): fetch timeline data for the active repo/worktree/target and refresh it on thread/diff SSE events.
- Conversation UI (`ConversationTimeline.tsx`): render commit rows interleaved with thread cards and keep empty/loading/error states clear.
- Tests: cover ordering by timestamp, commit metadata parsing, and a new commit appearing after refresh.

Verification: create a comment, commit a change, refresh/live update, and confirm the commit appears after the comment in Conversation while the thread remains manually resolvable.
Ships: Conversation becomes a GitHub-like history, not just a thread inbox.
Covers: commit entries, timestamp interleaving, new commit visibility.

### Slice 4 — Branch-wide and bounded Review Sessions

Tracer bullet: non-default branches automatically use a PR-like session boundary, while default/long-lived branches use bounded sessions that can complete when clean and thread-free.

Tasks:
- Shared/core session model (`packages/shared/src/index.ts`, new/existing `packages/core/src/reviews/*`): persist Review Session identity and lifecycle state separate from individual thread events, or encode session events in the append-only review store if that is the simpler compatible path.
- Git boundary detection (`packages/core/src/git/*`, `packages/core/src/workspace.ts`): determine current branch, default branch, fork point/merge-base, and whether the current branch is default.
- Session selection: for non-default branches, select/create a branch session bounded by merge-base/default branch; for default branch, select/create an active bounded session for the current workspace state.
- Session completion: detect clean workspace + no open threads on default/long-lived branch and mark/archive the active session without requiring a user ceremony.
- Thread/timeline filtering: scope Conversation timeline and thread queries to the selected session while preserving legacy/unscoped visibility.
- Tests: cover non-default branch boundary, default branch finite session, clean/no-open-thread completion, and legacy threads.

Verification: on a feature branch, Conversation includes commits since merge-base; on `main`, old unrelated branch history does not appear and a clean/no-open-thread session completes/archives.
Ships: timeline boundaries match user expectations for feature branches without turning `main` into an endless review feed.
Covers: non-default branch behavior, default branch bounded session lifecycle, Review Session ownership.

### Slice 5 — Conversation polish and stale/context cues

Tracer bullet: Conversation cards provide enough code context and visual cues to orient/review without opening the full diff for every thread.

Tasks:
- Code context (`packages/core/src/daemon.ts` file route or timeline route): provide compact context around a thread's anchor, including stale/outdated handling when re-anchoring fails.
- Web card rendering (`ConversationTimeline.tsx`, `ThreadConversation.tsx`): show compact code context, line range, stale/outdated badge, legacy/unscoped badge, and open-in-diff/open-in-editor actions.
- Navigation (`packages/web/src/App.tsx`, `DiffView.tsx`): let a Conversation card jump back to the Diff tab and scroll to the file/anchor where possible.
- Accessibility/responsive styling (`packages/web/src/styles.css`): ensure tabs, filters, timeline cards, and action buttons have keyboard/focus states and work at narrow widths.
- E2E/a11y tests (`packages/e2e/tests/a11y.spec.ts`, conversation spec): cover keyboard tab switch/filter operation and responsive timeline layout.

Verification: from Conversation, identify file/range/context, jump to the diff anchor, and use reply/resolve controls with keyboard and narrow viewport checks.
Ships: Conversation is useful as an overview/review surface rather than merely a list of comments.
Covers: code context, stale/legacy labels, open-in-diff/editor actions, visual density.

## Final Verification

- Run full validation, not only targeted checks: `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e`.
- Manual smoke: create comments in All/Staged/Unstaged, make a commit after a comment, switch between Diff and Conversation, resolve from Conversation, and confirm inline anchors still render correctly.

## Deferred

- Automatic comment resolution from commits — keep resolution manual until the timeline behavior is trusted.
- Checks/review-decision/activity-feed events beyond commits and Review Threads — defer until Diffect models those events explicitly.
- User-managed “New Review” ceremony — defer unless automatic bounded sessions on default branches prove confusing.
- Full migration/backfill of legacy threads into sessions/snapshots — keep legacy/unscoped visibility first; backfill only if needed.
- Exact visual density and tab naming (`Conversation` vs `Comments`) — tune during implementation without changing the model.

## Notes

- Source alignment lives in `question.md`; model vocabulary is also captured in `CONTEXT.md` and `docs/adr/0001-review-scope-sessions.md`.
- Avoid exposing raw `work` target jargon in UI copy. Use Review Scope / All local changes / Staged / Unstaged / base/compare language.
- `pnpm-workspace.yaml` had pre-existing modifications when this plan was created; this plan does not require touching it.
