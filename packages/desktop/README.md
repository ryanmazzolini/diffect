# Diffect Desktop

Diffect Desktop is a Tauri client for the persistent local Diffect daemon. A packaged launch synchronously ensures the installed daemon at `http://127.0.0.1:13433`, then opens the main window on that origin. The daemon serves both the web UI and API.

Desktop does not own the daemon process. Quitting the app leaves the daemon and browser links running. Reopening the app attaches to the same process. If the daemon crashes, the next app launch starts it again. A second app launch focuses the existing window and preserves the requested route while normalizing it to the canonical origin.

The installed desktop executable also exposes the machine-readable lifecycle commands used by other local clients:

```sh
diffect-desktop daemon activate --json
diffect-desktop daemon ensure --json
diffect-desktop daemon status --json
diffect-desktop daemon restart --json
diffect-desktop daemon stop --json
```

A packaged build is self-contained and needs no system Node installation:

```sh
mise run desktop:bundle   # → src-tauri/target/release/bundle/<format>/…
```

`scripts/build-sidecar.mjs` bundles the built daemon into a Node SEA, embedding the release version and immutable build ID. Tauri packages that sidecar and the matching `packages/web/dist` assets with the desktop executable. The desktop passes its stable launcher path and bundled web root to the sidecar manager.

On macOS, move `Diffect.app` to `/Applications` or `~/Applications` before its first managed launch. Set `DIFFECT_APP_PATH` to an absolute desktop executable path for an explicit installation, including local package smoke tests. Linux AppImages record the original `$APPIMAGE` path instead of the temporary mount.

Source development never claims the production daemon implicitly. Run the API and Vite server explicitly, then attach the source desktop client:

```sh
mise run daemon    # terminal 1: API on :7421
mise run dev       # terminal 2: Vite on :5173, proxying to the API
mise run desktop   # terminal 3: desktop client on the Vite origin
```

`mise run desktop` sets `DIFFECT_DESKTOP_URL=http://127.0.0.1:5173`. An explicit loopback URL passed on the command line works as well. These source origins are for UI development and receive no native desktop capabilities; use a packaged build for native integration testing. Release builds ignore `DIFFECT_DESKTOP_URL`.
