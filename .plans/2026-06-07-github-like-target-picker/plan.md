---
source: diffective
date: 2026-06-07
type: slice-plan
goal: Make Diffect's target selection reliable, searchable, and familiar for GitHub-like pre-PR review.
---

# GitHub-like Target Picker

**Status**: implemented
**Workflow**: `.plans/2026-06-07-github-like-target-picker/`

## Goal

A reviewer can confidently switch between local staged/unstaged work and GitHub-like base/compare targets, with searchable refs and commits that show useful labels.

## Acceptance Criteria

- Selecting a local review mode for all local changes, staged changes, or unstaged changes visibly changes the applied review target and reloads the diff.
- Selecting a base and compare value applies a GitHub-like `base...compare` Review Target Spec and reloads the diff.
- Base and compare pickers are searchable by branch name, tag name, commit short hash, full hash prefix, and commit subject.
- Commit search results show both short hash and commit subject.
- The picker has clear affordances for current target, loading, empty search results, and search errors.
- E2E coverage proves target changes update visible UI state, not just that no error appears.

## Slice Plan

### Slice 1 — Applied target feedback and local modes  [first: high value, low commitment]

Tracer bullet: In the browser, choose All local changes, Staged, and Unstaged and see the active control state change while the diff reloads without relying on hidden select state.

Tasks:
- [web target UI]: Replace the `work` jargon in `TargetPicker` with GitHub-like/local labels: All local changes, Staged, and Unstaged.
- [web state]: Synchronize picker base/compare state from the actual `target` prop so external changes cannot strand stale controls.
- [e2e]: Update branch/compare coverage to assert visible target control state, not just absence of errors.

Verification: Playwright target-picker coverage plus full build/typecheck/test run.
Ships: Target changes are visibly acknowledged and local review modes are understandable.
Covers: AC1, AC5, AC7.

### Slice 2 — Server-side searchable refs and commits

Tracer bullet: Typing a branch, tag, commit subject, short hash, or full hash prefix against the daemon returns grouped, capped Branches / Tags / Commits results.

Tasks:
- [shared API]: Add typed ref-search result contracts to `packages/shared/src/index.ts`.
- [git layer]: Add `searchRefs` in `packages/core/src/git/refs.ts` using full server-side history search with capped results and branch/tag ranking ahead of commits.
- [daemon API]: Add `GET /repos/:repo/refs/search?q=&limit=&worktree=` and wire it through repo/worktree resolution.
- [tests]: Add core API/git coverage for branch matches and commit subject/hash matches.

Verification: Core tests for search behavior plus full build/typecheck/test run.
Ships: The UI can search full history without preloading painful commit dropdowns.
Covers: AC3, AC4.

### Slice 3 — Searchable GitHub-like base/compare picker

Tracer bullet: Open the base or compare picker, type a query, choose a branch/tag/commit result, and see a `base...compare` target applied with commit results labeled `shortsha subject`.

Tasks:
- [web target UI]: Replace native base/compare selects with accessible searchable popovers grouped into Branches, Tags, and Commits.
- [web API]: Call the new ref-search endpoint on open/query and show loading, empty, and error states.
- [web polish]: Remove redundant topbar affordances and keep keyboard open/search/select/escape behavior usable.
- [e2e]: Cover branch selection and commit search label display through the browser.

Verification: Playwright coverage for target application and commit labels plus full build/typecheck/test run.
Ships: Review target selection feels GitHub-like and usable for real repo history.
Covers: AC2, AC3, AC4, AC5, AC6, AC7.

## Deferred

- Durable PR/session objects — defer because Review Target Specs remain sufficient for pre-PR review and are cheaper to change.
- Fork/date comparisons — defer until local pre-PR branch/commit comparison is excellent.
- Perfect GitHub parity for arbitrary commit URL editing — keep raw target specs internal/API-side unless an advanced UI proves necessary.

## Notes

- Keep three-dot `base...compare` as the default compare operator.
- Keep `work`, `staged`, and `unstaged` as internal target specs, but do not force users to understand `work` jargon.
- Server-side search should cap results for responsiveness and rank branch/tag matches ahead of commit matches.
