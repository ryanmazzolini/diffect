# Quarantined specs (pre-`git-diff-view` renderer)

These specs assert the **old hand-rolled diff DOM** (`tr.line-add`,
`button.comment-btn`, `.ln-clickable`, `table.hunk`, `.hunk-split`,
`.diff-word`, gutter-drag selection, `.code` `white-space`, …). The diff body
is now rendered by [`@git-diff-view/react`](https://github.com/MrWangJustToDo/git-diff-view),
so these no longer match and are excluded via `testIgnore: "**/legacy/**"` in
`playwright.config.ts`.

Core coverage was reimplemented against the new DOM in
`tests/git-diff-view.spec.ts` (render / comment / split / wrap). To fully retire
this folder, port each spec to the lib's DOM:

- comment trigger: hover a `tbody.diff-table-body tr`, click `button.diff-add-widget`
- split markers: `.diff-line-old-content` / `.diff-line-new-content`
- wrap state: `.unified-diff-view-wrap` vs `.unified-diff-view-normal`

## Two genuine regressions to resolve before adopting

1. **Keyboard a11y of line selection** — our gutter was keyboard-operable
   (`drag-select.spec.ts` "the gutter is keyboard-operable"). git-diff-view's
   selection is **mouse-only**; there is no keyboard line-nav/selection. This
   must be re-added on top, or it's a real accessibility regression.

2. **Context expansion ("expand N lines")** — `expand-context.spec.ts`. The lib
   can expand surrounding context, but only if given full file `content`. We
   currently feed it hunk text only (no content), so expansion is inert. Wiring
   it needs old+new file content from the daemon (`/file` already serves ranges).
