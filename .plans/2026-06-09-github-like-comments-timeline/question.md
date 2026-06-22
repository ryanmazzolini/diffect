---
source: diffect
date: 2026-06-09
type: question-log
goal: Rework Diffect's review comments from a right sidebar into a GitHub-like main Conversation timeline while preserving inline diff comments.
---

# GitHub-like Comments Timeline — Alignment Log

## Goal

Give review comments more room and better chronology by replacing the right comments sidebar with a main-content Conversation timeline that can interleave review threads with commits, while keeping inline comments anchored in the Diff view.

## From Docs / Code

- `CONTEXT.md` defines a Review Thread as the durable comment conversation attached to a selected file range in a review session.
- `ThreadConversation` is already shared by inline diff comments and the current right-side `ThreadList`, so reply/close/open controls can be reused in a wider timeline surface.
- The current app layout is left file sidebar, central diff pane, and resizable/collapsible right `thread-pane`.
- The current shared API exposes thread timestamps (`createdAt`, `updatedAt`, comment `ts`) and recent commit refs with SHA/subject, but commit timeline entries may need richer timestamp/author data.
- Commit `b1e1f5f` intentionally kept Review Target Specs internal while removing the `work` jargon from the UI: local modes are user-facing `All local changes`, `Staged changes`, and `Unstaged changes`, plus GitHub-like base/compare pickers.
- As of current `main`, `App` initializes the internal target to `work`, `TargetPicker` exposes user-facing `All`/`Staged`/`Unstaged` plus base/compare controls, and `normalizeTarget` still supports `work`, `staged`, `unstaged`, refs, and `a..b`/`a...b` ranges.
- Current `CreateThreadRequest` does not include the selected review scope/target, and `thread.created` events do not store a scope identity; comments are keyed only by repo/worktree/file/side/line/anchor plus timestamps/status.
- Current daemon comment creation builds anchors from `resolveWorkBase(...)` rather than the selected review scope, so target-specific old-side anchoring is not modeled yet.

## Question Log

### Q1 — Right comments pane

Question: Do you want to remove the right thread pane entirely, while keeping the left file sidebar?
Recommended answer: Yes — keep file navigation/progress, but move thread browsing into the main content so the diff gets its horizontal space back.
User answer: Sounds good.
Decision: Remove the persistent right comments pane as the primary browsing surface; keep the left file sidebar.

### Q2 — Timeline contents

Question: Should the new main tab be a Review Thread timeline only, or a broader GitHub-like activity feed with commits/checks/review events too?
Recommended answer: Thread timeline only for now — Diffect already models threads well, but not PR lifecycle events.
User answer: Interleave commits and comments by timestamp. If a new commit is added to a branch after a comment, the history should show that and the user can optionally resolve the comment.
Decision: Build toward a Conversation timeline that includes review threads and commit entries ordered by time.

### Q3 — Inline diff comments

Question: In the Diff tab, should inline comments stay visible at their code anchors?
Recommended answer: Yes — Diff keeps GitHub-style inline review; Conversation/Comments becomes the overview stream for reading/replying/resolving across files.
User answer: Yes, definitely keep inline comments.
Decision: Preserve inline anchored comments in the Diff tab.

### Q4 — Timeline thread granularity

Question: Should thread activity render as one card per Review Thread, with replies inside, rather than one timeline item per reply/status event?
Recommended answer: One card per thread for MVP, sorted by thread creation/update, with commits interleaved.
User answer: Yes, sounds good.
Decision: Use one timeline card per Review Thread for the first version; replies and status controls live inside the card.

### Q5 — User-facing review scope language

Question: What is the "current target"? Did we forget cleanup because `work` / base compare were removed in a recent commit?
Recommended answer: Treat `work` and range specs as internal Review Target Specs, but use the post-`b1e1f5f` user-facing language: All local changes, Staged, Unstaged, and base/compare.
User answer: Pointed to commit `b1e1f5f`, whose message says local modes remain visible without exposing internal `work` target jargon.
Decision: Do not use `work` or raw target-spec jargon in the Conversation UI. Timeline planning should say active review scope / selected review mode, mapping to internal Review Target Specs only in implementation notes.

### Q6 — Scope snapshot identity

Question: Should the model be fixed to distinguish comments made against Staged/Unstaged/All at different HEAD/index/worktree states?
Recommended answer: Yes. Add a durable review-scope snapshot identity with resolved git state such as `headSha`, index tree, worktree fingerprint, and resolved base/compare SHAs.
User answer: Sounds good.
Decision: Threads should record the review scope/snapshot they were created in so comments from different commits or different staged/unstaged snapshots do not collapse into one ambiguous bucket.

### Q7 — Branch-wide timeline boundaries

Question: Should “branch-wide timeline” be automatic only when the current branch is not the default branch?
Recommended answer: Yes — it gives PR-like behavior on feature branches and avoids turning `main` into an endless review feed.
User answer: Yeah, sounds good.
Decision: Non-default branches can automatically show a branch-wide PR-like timeline bounded by the fork point/merge-base with the default branch. Default or long-lived branches should use explicit ranges or smaller active review sessions/snapshots, not the whole branch.

### Q8 — Review Scope language

Question: Should we rename the user-facing/core model from Review Target Spec to Review Scope, keeping target specs as internal git-query serialization only?
Recommended answer: Yes, because the UI already speaks in scopes: All, Staged, Unstaged, base/compare.
User answer: Sounds good.
Decision: Use Review Scope as the product/domain term for what the user is reviewing; keep Review Target Specs as internal git-query serialization.

### Q9 — Durable Review Session grouping

Question: Should Review Session become the durable grouping that owns timeline history and snapshots?
Recommended answer: Yes: feature branches get an implicit PR-like session; default/long-lived branches get bounded sessions.
User answer: Sounds good.
Decision: Persist Review Sessions as the grouping for timeline history, commits, scope snapshots, and review threads.

### Q10 — Default-branch session lifecycle

Question: For default/long-lived branches, should an active session end automatically when the workspace is clean and no open threads remain?
Recommended answer: Yes, because it avoids a “New Review” ceremony while keeping `main` timelines finite.
User answer: Sounds good.
Decision: Default/long-lived branch sessions should be bounded automatically: once the workspace is clean and no open threads remain, the session can be considered complete/archived.

## Resolved Decisions

- Main review surfaces: Use central tabs for `Diff` and `Conversation`/comments rather than a persistent right comments pane.
- Sidebar scope: Keep the left file sidebar for workspace/repo/file navigation and viewed progress.
- Inline comments: Keep inline comment threads rendered at their code anchors in the Diff view.
- Timeline direction: The main conversation surface should interleave review thread activity and commits by timestamp so the user can understand review history.
- Resolution workflow: Timeline thread cards should allow manual reply/resolve actions after the user sees a relevant commit.
- Thread granularity: Render one card per Review Thread for the first timeline version, not one item per reply/status event.
- Language: The UI should say active review scope / selected review mode and user-facing labels, not `work` or raw Review Target Spec jargon.
- Scope identity: Review Threads need a durable scope/snapshot identity so Staged/Unstaged/All comments from different HEAD/index/worktree states are distinguishable.
- Branch boundaries: Automatic branch-wide timelines apply only on non-default branches; default/long-lived branches use explicit ranges or bounded active review sessions.
- Review Scope: Use Review Scope as the product/domain term for what the user is reviewing; keep Review Target Specs as internal git-query serialization.
- Review Session: Persist Review Sessions as the durable grouping for timeline history, commits, scope snapshots, and Review Threads.
- Default-branch lifecycle: Automatically complete/archive default or long-lived branch sessions when the workspace is clean and no open threads remain.

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

## Assumptions

- Use the project term Review Thread for comment conversations; use Conversation or Timeline for the GitHub-like main tab UI.
- Use user-facing review-scope labels in UI/copy: All local changes, Staged, Unstaged, Base, Compare.
- Keep manual thread resolution; do not auto-resolve comments merely because a newer commit appears.
- Code context in the Conversation timeline can be compact, optimized for orientation rather than full diff review.
- The first implementation can reuse existing thread rendering and add richer commit metadata only where needed.
- Legacy threads without scope/session metadata remain visible as legacy/unscoped rather than hidden.
- Copy, exact tab labels, and visual density are low-risk and can be tuned during implementation.

## Open Questions

- None blocking. Exact snapshot hash fields and timeline visual density can be finalized during implementation planning.

## Suggested Plan Direction

Implement this in model-first slices: introduce persisted Review Sessions and Review Scope Snapshots, attach new Review Threads to the active session/snapshot, keep legacy threads visible, then replace the right pane with main tabs and a wide Conversation timeline. Add commit timeline data for the active review scope/session and interleave commit entries with one-card-per-thread Review Thread activity. Verify inline diff comments still work and that branch/default-branch timeline boundaries behave differently.
