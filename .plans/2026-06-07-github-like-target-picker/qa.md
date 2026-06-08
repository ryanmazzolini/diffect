---
source: diffective
date: 2026-06-07
type: qa-log
goal: Verify the GitHub-like target picker implementation.
---

# GitHub-like Target Picker — QA

## Verification

- `pnpm -r build` — passed.
- `pnpm --filter @diffect/e2e test -- branch-compare review a11y` — passed.
- `pnpm -r test` — passed: 31 Playwright tests, 94 core Vitest tests.
- `pnpm -r typecheck` — passed.
- `git diff --check` — passed.

## Coverage Notes

- Playwright now proves visible target state for local modes and base/compare refs.
- Playwright verifies commit search results include short hash plus subject.
- Core tests verify server-side search by branch, tag, commit subject, and SHA prefix.
- Axe a11y coverage passes for dark/light/split views after active target contrast adjustment.

## Residual Risks

- The custom picker is intentionally lightweight; deeper screen-reader testing of the open popover would be useful later.
- Commit search is capped for responsiveness and may need tuning on very large repositories.
