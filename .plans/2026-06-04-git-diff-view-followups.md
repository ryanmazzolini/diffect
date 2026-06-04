---
source: diffective
date: 2026-06-04
type: follow-ups
goal: Resolve the regressions introduced by migrating the diff renderer to @git-diff-view/react.
---

# git-diff-view migration — follow-ups

Context: the diff body now renders via `@git-diff-view/react` (replaced the
hand-rolled table renderer, which kept producing split/wrap alignment
artefacts). Merged to `main`. Two capabilities regressed in the swap and are
tracked here.

## TODO: keyboard a11y of line selection (priority)

The old gutter was keyboard-operable (focus a line number, Enter to comment,
Shift+Arrow to extend a range) and had an axe gate. git-diff-view's selection is
**mouse-only** — no keyboard line navigation or selection.

- Re-add keyboard-driven line focus + range selection on top of the lib (it
  exposes `setPreselectedLines`, `getSelectionResult`, and
  `DiffMultiSelectManager`; a keyboard layer can drive the same selection state).
- Restore the keyboard-operability assertion (was
  `tests/legacy/drag-select.spec.ts` "the gutter is keyboard-operable").

## TODO: context expansion ("expand N lines")

Currently inert-but-absent: we feed the lib hunk text only, so `getExpandEnabled`
is false and the "expand" affordance is hidden (graceful, not broken).

- To enable: supply old + new file `content` to the lib's `DiffFile`. The daemon
  `/file` route already serves line ranges; add full-content fetching (old via
  `git show <base>:<path>`, new via working-tree read) and pass it through
  `packages/web/src/components/DiffView.tsx`.

## DONE: e2e specs reconciled with the new renderer

`tests/legacy/` removed. The four specs covering live, renderer-independent
behavior (composer, dismiss-delete, resilient, review) were ported to the lib's
add-widget and kept; the renderer-internal specs (drag-select, expand-context,
highlight, range-comment, screenshot, split-view, word-diff, wrap-toggle) were
deleted — they're now owned by the lib or re-covered in
`tests/git-diff-view.spec.ts`. Caveat: the deleted `drag-select` spec also
covered keyboard-operability of the gutter — that assertion returns with the
keyboard-a11y work above.
