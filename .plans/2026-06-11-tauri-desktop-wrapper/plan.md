---
date: 2026-06-11
type: slice-plan
goal: Ship Diffect as a double-clickable desktop app by wrapping diffectd + the web UI in a Tauri shell.
---

# Tauri Desktop Wrapper

**Status**: slices 1–3 implemented (CI deferred — the repo has no CI yet); slice 4 affordances open
**Workflow**: `.plans/2026-06-11-tauri-desktop-wrapper/`

## Goal

A user installs one desktop app, launches it, and gets the full Diffect review
UI — no Node/pnpm/mise setup, no terminal, no browser tab. The CLI, agents, and
a manually run `diffectd` keep working against the same store, live.

## Why this architecture

The codebase is already shaped like a desktop app waiting for a shell:

- `diffectd` is a self-contained Node HTTP server (`node:http` only, zero
  runtime deps beyond `@diffect/shared`) serving static assets + JSON API + SSE.
- The web UI uses **relative URLs** for all API calls and
  `new EventSource("/events")` — pointed at the daemon's origin, it needs zero
  changes.
- State is plain files in `~/.config/diffect/`, and the daemon **fs.watches the
  store** (`events.ts`), so external writers (CLI, agents, another daemon
  instance) already propagate to connected UIs over SSE. Running a second,
  app-private daemon instance is safe — the append-only log + watcher design
  was built for exactly this kind of multi-writer cooperation.

So the wrapper is: **Tauri v2 shell → spawn diffectd as a sidecar on an
ephemeral loopback port → open the window at that origin.** No Rust
reimplementation of the API, no IPC bridge, no web UI fork.

Rejected alternatives:

- *Serve assets from `tauri://` + reimplement the API in Rust*: rewrites 800+
  lines of daemon (git, anchoring, SSE, editor handoff) for no user-visible
  gain; forks the contract three ways instead of two.
- *Reuse an already-running daemon on 7421*: saves a process but makes app
  startup depend on external state, and version skew between app UI and a
  stale manual daemon gets confusing. Private ephemeral port instead; the
  shared store + file watching keeps both daemons coherent anyway.
- *Electron*: bundles a second Chromium + Node per install; Tauri's system
  webview keeps the app small, and we must solve "ship the Node daemon" either
  way.

## Decisions to confirm

1. **Sidecar runtime packaging** (Slice 3): recommend **Node SEA** (single
   executable application) — esbuild-bundle `daemon-bin.ts` to one CJS file,
   inject into the pinned Node 24 binary with `postject`. Stays on the exact
   runtime the project pins. Alternatives: `bun build --compile` (simpler
   tooling, but a second runtime to trust for `node:http`/`fs.watch`
   semantics) or requiring system Node (defeats the purpose).
2. **Platform order**: recommend macOS first (likely the dev machine), then
   Linux (AppImage/deb), then Windows (needs a path-handling audit — the store
   keys by repo path).
3. **Updater + code signing**: deferred past this plan; unsigned local builds
   until the wrapper proves out.

## Acceptance Criteria

- Launching the app opens a window showing the Diffect UI with the user's
  registered workspaces, without any terminal interaction.
- The app's daemon binds `127.0.0.1` on an ephemeral port and never collides
  with a manually run `diffectd` on 7421.
- Quitting the app reliably terminates its daemon (no orphaned processes);
  a daemon crash surfaces an error state instead of a dead white window.
- A comment added via the CLI while the app is open appears live in the app
  (shared store + SSE path proven end-to-end).
- "Open in editor" and external `http(s)` links work: editor handoff via the
  existing daemon route, links in the system browser (not the webview).
- A packaged build (e.g. `.app`/`.dmg`) runs on a machine with no Node, pnpm,
  or mise installed.

## Slice Plan

### Slice 1 — Walking skeleton: window over a spawned daemon  [first: proves the whole shape]

Tracer bullet: `mise run desktop` builds the monorepo, launches a Tauri window,
and you review a repo in it; quitting kills the daemon.

Tasks:
- [core daemon]: Support `--port 0` and emit a machine-readable ready line with
  the *resolved* port from `server.address()` (today `daemon-bin.ts` prints the
  requested port, which would print `0`). Keep the human-readable line.
- [core daemon]: Add `--web-root <dir>` (or `DIFFECTD_WEB_ROOT`) so the daemon
  can serve assets from an explicit path — `locateWebRoot()`'s relative
  monorepo lookup won't survive packaging, and Slice 1 can start using the
  explicit flag immediately.
- [desktop]: New `packages/desktop/` with a Tauri v2 app (`src-tauri/`): spawn
  `node <repo>/packages/core/dist/daemon-bin.js --port 0 --web-root …` (dev
  uses system node; sidecar packaging is Slice 3), parse the ready line,
  health-check, then create the main window at `http://127.0.0.1:<port>`.
- [tooling]: Add Rust to `mise.toml`; add `desktop` (build + run) and
  `desktop:dev` tasks.

Verification: manual run on the dev platform; comment from the CLI while the
app is open and watch it appear live. Core tests cover the new daemon flags.
Ships: Diffect opens as an app window instead of a browser tab.
Covers: AC1, AC2 (partially), AC4.

### Slice 2 — Lifecycle robustness and window chrome

Tracer bullet: kill the daemon process while the app is open and get a visible
error state with a Retry that recovers; quit the app and verify no `diffectd`
survives; click a marketing link in a comment and it opens in your browser.

Tasks:
- [desktop]: Kill the child on `ExitRequested`/window close; detect child exit
  while running and show a native error window with retry (respawn + reload).
- [desktop]: Single-instance plugin — second launch focuses the existing
  window instead of spawning a second daemon.
- [desktop]: Route external `http(s)` navigation to the system browser
  (`tauri-plugin-opener`); keep the daemon origin in-webview.
- [desktop]: App identity — name, icons, minimal native menu (About, Quit,
  Reload, standard edit menu so copy/paste works in the webview).

Verification: scripted kill/relaunch checks on the dev platform; `ps` audit
after quit.
Ships: the wrapper behaves like an app, not a kiosk around a fragile process.
Covers: AC3, AC5.

### Slice 3 — Self-contained packaging (no Node on the host)

Tracer bullet: `tauri build` produces an installable artifact; on a clean
machine (or a container/VM without Node), the app launches and reviews a repo.

Tasks:
- [desktop build]: esbuild-bundle `daemon-bin.ts` → single CJS file; build a
  Node SEA binary per target triple (`diffectd-<triple>`) and register it as a
  Tauri sidecar (`externalBin`).
- [desktop build]: Ship `packages/web/dist` as a Tauri resource; launch the
  sidecar with `--web-root` pointing into the resource dir.
- [desktop build]: Wire the sidecar/SEA build into the `desktop` mise task and
  a CI job per platform (macOS first, per decision 2).
- [docs]: README section — what the app is, where state lives (unchanged:
  `~/.config/diffect/`), how it coexists with the CLI and a manual daemon.

Verification: install the artifact on a Node-less environment; run the AC4
CLI-liveness check there too.
Ships: a double-clickable Diffect anyone can install.
Covers: AC6, completes AC2.

### Slice 4 — Desktop affordances (optional, after the wrapper is excellent)

Candidates, in value order — pick after living with Slices 1–3:
- Dock/taskbar badge with the open-thread count (subscribe to `/events` from
  Rust or a tiny bridge page).
- Native folder picker as an alternative entry to the existing in-app browser
  for adding workspaces.
- "Open this repo in Diffect" deep link / file association for `diffect://`.
- Auto-updater + signing (decision 3 revisited).

Ships: reasons to prefer the app over `mise run daemon` + browser tab.

## Risks

- **Node SEA friction**: SEA wants CJS and has rough edges per platform
  (notarization on macOS after `postject`). Mitigation: the daemon is
  dependency-free so the bundle step is trivial; if SEA fights back, the
  fallback is `bun build --compile` behind the same sidecar interface.
- **System webview variance** (WKWebView/WebView2/WebKitGTK): the UI already
  targets browsers, and SSE/`EventSource` is universally supported; test the
  diff view's sticky headers and resize behavior per platform in Slice 3.
- **fs.watch recursive on Linux**: the store watch uses
  `watch(dir, { recursive: true })`, which Node supports on Linux only in
  newer versions — pinned Node 24 covers it, so the SEA build must stay on
  the pinned runtime (another reason to prefer SEA over a different runtime).
