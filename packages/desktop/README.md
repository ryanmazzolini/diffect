# Diffect Desktop

A Tauri shell over diffectd. On launch it spawns a private daemon with
`--port 0 --no-workspace` (ephemeral loopback port, registered workspaces
only), waits for the daemon's `DIFFECTD_READY <url>` stdout line, and opens
the main window at that origin. The web UI is served by the daemon and uses
relative URLs, so it runs unmodified; review state lives in the same per-user
store (`~/.config/diffect/`) the CLI, agents, and any manually run daemon
share — the daemon's store watcher pushes their writes into the window live.

Lifecycle: the daemon is spawned with `--exit-on-stdin-close` and a pipe the
shell holds open, so it dies with the app even if the app is killed without
cleanup; a normal quit also kills it explicitly. If the daemon dies under a
running window it is respawned (up to 3 times per minute, then a visible
error). A second app launch focuses the existing window. Navigation stays
in-window for loopback origins; anything else (links in comments) opens in
the system browser.

```sh
mise run desktop        # build the monorepo, then launch the app
```

The dev build runs the daemon from `packages/core/dist` with the system
`node`. A packaged build is self-contained — no Node on the host:

```sh
mise run desktop:bundle   # → src-tauri/target/release/bundle/<format>/…
```

`scripts/build-sidecar.mjs` esbuild-bundles the built daemon to one CJS file
and injects it into the running Node binary as a SEA (single executable
application), emitting `src-tauri/binaries/diffectd-<target-triple>`; `tauri
build --config src-tauri/tauri.bundle.conf.json` then bundles that sidecar
plus `packages/web/dist` (as a resource) into platform installers. At
runtime the shell prefers a `diffectd` sidecar sitting beside the app
executable and falls back to the monorepo layout, so dev and packaged builds
share one code path. macOS signing is ad-hoc for now; notarization and an
updater are future release work.

For UI work with hot reload, point the shell at an existing origin instead of
spawning a daemon:

```sh
mise run daemon         # terminal 1: API on :7421
mise run dev            # terminal 2: Vite on :5173 (proxies to the daemon)
mise run desktop:dev    # terminal 3: window on the Vite origin
```

(`desktop:dev` sets `DIFFECT_DESKTOP_URL=http://127.0.0.1:5173`; set it
manually to any URL to do the same.)
