# UI performance investigation — settings / workspace / unified↔split lag

**Symptom (reported):** long, visible delay on every state change — switching
workspaces/repos, toggling Unified↔Split, density, wrap, theme. Target: Linear-grade
snappiness (<~16ms perceived, definitely sub-100ms).

**Baseline workload (the diffect repo's own working diff):** 19 files,
**6,689 diff lines** across all hunks, largest file `styles.css` at 1,295 lines.
With nothing marked viewed, **all 19 files render expanded at once.** The diff body
is rendered by `@git-diff-view/react@0.1.5`, which has **no virtualization /
windowing** (verified: no `virtual` / `IntersectionObserver` / `requestIdleCallback`
in its dist). So the live DOM is ~6,700 rows × (5–15 nodes/row) ≈ 30k–100k nodes.

---

## Concern areas (separated by concern)

### Concern 1 — No virtualization: a single toggle reconciles the entire diff
**Severity: high. Explains the Unified↔Split / wrap / theme lag.**

`split`, `wrap`, and `theme` are passed as props into every `FileDiff`
(`DiffView.tsx:104-118`), each of which renders a `DiffViewWithMultiSelect`
(`DiffView.tsx:327-338`). Changing any one flips the prop on all expanded files,
so React reconciles **all 6,689 rows synchronously on the main thread** in one
commit. Unified↔Split is the worst case: the row structure changes (1 column →
2 columns), so it's a structural unmount+remount of every row, not a cheap update.

- The `diffFile` instance is memoized per file and pre-builds *both* split and
  unified line models (`DiffView.tsx:204-220`), so parsing/highlighting is **not**
  repeated — good. The cost is pure React reconciliation + DOM mutation of the row set.
- Collapsed (viewed) files don't mount the library (`{!collapsed && …}`,
  `DiffView.tsx:326`), so the cost scales with *expanded* files. First load = all of them.

### Concern 2 — Broken memoization: heavy panels re-render on unrelated state
**Severity: high (cheap fix). Explains lag that has nothing to do with the diff.**

`DiffView` and `Sidebar` are both `memo()`-wrapped, but App hands each a **freshly
allocated closure every render**, defeating the memo:
- `onBackToDiff={() => setPreviewFile(null)}` → `DiffView` (`App.tsx:490`)
- `onShowDiff={() => setPreviewFile(null)}` → `Sidebar` (`App.tsx:465`)

Because these references change on *every* App render, `DiffView`'s body re-runs on
every scroll-spy `setActiveFile` tick, every resize commit, every filter/density/theme
change — recomputing `groupThreadsByFile`, `inDiff`, `outOfDiff` each time. (The inner
`FileDiff`s are still individually memoized on stable props, so they mostly skip — but
the parent churn is pure waste and amplifies everything else.) `toggleTheme`
(`App.tsx:80`) is also not `useCallback`-wrapped, though Topbar isn't memoized so that
one is currently moot.

### Concern 3 — Global CSS-variable swaps force a full-document reflow
**Severity: medium–high. Explains density lag specifically (it's not even React).**

`changeDensity` / `setTheme` flip `data-density` / `data-theme` on `<html>`
(`density.ts`, `theme.ts`), which mutate `:root` custom properties like `--row-h`,
`--diff-size`, `--diff-lh`. Those feed the entire 6,700-row diff table, so the browser
**invalidates layout for the whole document** and reflows every row. This is a
browser-layout cost independent of React — even a perfectly memoized tree pays it while
the giant DOM exists. (Theme is mostly repaint = cheaper; density changes sizes = full
reflow = the expensive one.)

### Concern 4 — Workspace/repo switch remounts the whole diff and cascades fetches
**Severity: medium. Explains workspace-switch lag.**

`setRepo` triggers a fan-out (`App.tsx:224-260`): reset worktree → refetch diff +
refs + repoFiles + reload viewed-set, then `setDiff` mounts a **brand-new full diff**
(another ~6,700-row first paint). There's also no explicit loading state during the
swap — the stale diff sits until the new one replaces it. Cost = network + a cold
full-diff mount.

### Concern 5 — Scroll-spy churn (minor, falls out of #2)
`IntersectionObserver` calls `setActiveFile` as you scroll (`App.tsx:269-287`),
re-rendering App on every scroll-stop. Harmless once Concern 2 is fixed and children
actually skip; optionally wrap in `startTransition`.

---

## Fix order (systematic, cheapest-highest-leverage first)

1. **Concern 2** — hoist the two `() => setPreviewFile(null)` closures into one stable
   `useCallback`; `useCallback` `toggleTheme`. *(trivial; stops the cascade)*
2. **Concern 1/3 toggles** — wrap split/wrap/density/theme state updates in
   `startTransition` so the click commits instantly and the heavy reconcile/reflow
   runs at low priority without freezing the control. *(small; kills the "frozen" feel)*
3. **Theme via CSS only** — stop passing `diffViewTheme`; let our `[data-theme]` CSS
   own diff colors so a theme toggle is repaint-only, no row re-render. *(validate the
   library honors external CSS without the prop)*
4. **Concern 1 real fix — file-level windowing** — gate each `FileDiff`'s library mount
   behind an `IntersectionObserver`, rendering an known-height placeholder when
   offscreen. Caps live DOM regardless of diff size; makes every global toggle O(visible)
   instead of O(total). *(largest change; the actual ceiling-buster)*
5. Re-measure after each step; **Concern 4/5** should largely fall out of 1–4.

---

## Benchmarking

Primary metric = **interaction→next-paint latency** (what the user feels), measured
by `bench.js` in this folder (paste into DevTools console on the running app). It
clicks each real control and times click→double-rAF, reporting p50/min/max over 5 runs,
plus live DOM-node count. Run it **with all files expanded** (nothing viewed) on the
diffect repo for the worst case. Capture baseline → apply fixes 1→4 → re-run after each.

Secondary (attribution, optional): a temporary React `<Profiler onRender>` around the
diff subtree to confirm a fix cut *commit* duration vs. *layout* duration.
