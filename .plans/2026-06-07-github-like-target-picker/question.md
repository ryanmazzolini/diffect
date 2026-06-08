---
source: diffective
date: 2026-06-07
type: question-log
goal: Make Diffect's target selection functional and GitHub-like for human-agent pre-PR review.
---

# GitHub-like Target Picker — Alignment Log

## Goal

Make changing the review target in the workspace UI reliable and polished, replacing painful commit dropdowns with a GitHub-like searchable base/compare experience that supports human-agent review before a PR is submitted.

## From Docs / Code

- `CONTEXT.md` defines Diffect as a local-first review app and the user-facing concept as a Review Target Spec.
- The default Review Target Spec is currently `work`, meaning committed-since-base, unstaged, and untracked changes.
- Existing target specs include `work`, `staged`, `unstaged`, single refs, and `a..b` / `a...b` ranges.
- `TargetPicker` currently uses native `<select>` controls; base/compare applies `base...compare` only when both sides are selected.
- The daemon already returns commits as `{ sha, subject }`, but the current UI only lists SHA values.
- Existing e2e coverage confirms the picker does not error, but does not prove the target visibly changes or that commit labels are usable.
- GitHub Compare supports branches, tags, commits, forks, and dates; its documented common path is branch comparison via base/compare dropdowns, while arbitrary commit comparisons are usually expressed by editing the compare URL with commit SHAs.

## Question Log

### Q1 — Workflow framing

Question: Should this stay a target picker, not become a PR/session workflow?
Recommended answer: Keep `work/staged/unstaged`, GitHub-style `base...compare`, and raw refs because that matches the project model.
User answer: A pre-PR workflow is acceptable; the more similar to GitHub the better. This is for review between a human and a coding agent before submitting a PR.
Decision: Move the UI toward a GitHub-like pre-PR review affordance while keeping Diffect local-first and target-spec based internally.

### Q2 — Ref selection interaction

Question: Should ref picking become a searchable combobox/popover instead of native dropdowns?
Recommended answer: Yes; show branches/tags plus commits as `shortsha subject`, filter by hash/name/title, and apply immediately on selection.
User answer: Yes, and also fix UI affordances and polish.
Decision: Replace the base/compare native commit dropdowns with polished searchable pickers.

### Q3 — Commit search source

Question: Should commit search use the existing recent commits API first, or add server-side full-history search now?
Recommended answer: Use existing recent commits first because the API already has enough data and the UI bug is the immediate pain.
User answer: Full server-side search is probably a better UX.
Decision: Add server-side search rather than relying only on the existing recent-commit list.

### Q4 — Default target presentation

Question: Should the default visible target remain `work`, or shift to GitHub-like `base: main/default` → `compare: HEAD`?
Recommended answer: Keep `work` as the default but present it as the pre-PR working review mode because it includes uncommitted agent fixes.
User answer: Move toward GitHub instead because it is more familiar, but also show unstaged/staged.
Decision: Make the primary presentation GitHub-like base/compare, while preserving staged and unstaged as visible local-only review modes.

### Q5 — Commit results layout

Question: Should commit results appear in the same picker as branches/tags, or behind a separate “Commits” tab/section?
Recommended answer: Same picker, grouped as Branches / Tags / Commits, because it is faster and still familiar.
User answer: Sounds good.
Decision: Use one searchable picker with grouped sections for Branches, Tags, and Commits.

### Q6 — Redundant topbar affordances

Question: Should the “Viewing …” chip and raw `ref or a..b` input stay in the topbar?
Recommended answer: Remove both; the active local-mode buttons and base/compare controls already show state, and raw specs can remain internal/API-side without being primary UI.
User answer: Yes.
Decision: Remove the redundant applied-target bubble and remove the raw target input from the topbar.

## Resolved Decisions

- Pre-PR framing: The target picker should feel closer to GitHub's branch/commit comparison UI because the review happens before a PR exists.
- Default presentation: Prefer GitHub-like base/compare as the primary mental model, with staged/unstaged still visible for local review.
- Search interaction: Use searchable picker/popover controls instead of native dropdowns for refs and commits.
- Picker layout: Use one searchable picker grouped into Branches, Tags, and Commits.
- Commit display: Show commit short hash plus commit subject in search results.
- Search backend: Support full server-side search for commits/refs, not only the existing last-30 commit list.
- Topbar simplification: Do not show a separate “Viewing …” chip or raw target input in the primary target picker.

## Acceptance Criteria

- Selecting a local review mode for all local changes, staged changes, or unstaged changes visibly changes the applied review target and reloads the diff.
- Selecting a base and compare value applies a GitHub-like `base...compare` Review Target Spec and reloads the diff.
- Base and compare pickers are searchable by branch name, tag name, commit short hash, full hash prefix, and commit subject.
- Commit search results show both short hash and commit subject.
- The picker has clear affordances for current target, loading, empty search results, and search errors.
- E2E coverage proves target changes update visible UI state, not just that no error appears.

## Assumptions

- Keep three-dot `base...compare` as the GitHub-style default compare operator.
- Keep Diffect's normalized Review Target Spec model internally; do not introduce a durable PR object or user-managed review session.
- Limit server-side search results for responsiveness and avoid rendering huge history lists.
- Search refs and commit history server-side with capped results; branch/tag matches should rank ahead of commit matches.
- Preserve keyboard accessibility for opening, searching, selecting, and closing the custom picker.

## Open Questions

- None blocking. Search ranking/scope details can be tuned during implementation.

## Suggested Plan Direction

Implement this as a focused UI/daemon refinement: first fix target state synchronization and visible local/base-compare control state, then add a `/refs/search`-style API that returns typed branch/tag/commit options, then replace native base/compare selects with accessible searchable pickers and add E2E coverage for quick targets, base/compare targets, and commit search result labels.
