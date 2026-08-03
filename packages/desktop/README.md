# Diffect Desktop

A Tauri shell over the clean Review daemon. On launch it first probes the
canonical `http://127.0.0.1:7421` origin. It reuses a compatible running daemon
or starts the bundled daemon with `--port 7421 --no-workspace`, then opens the
Review UI at that origin. A non-Diffect process occupying the port produces a
visible startup error rather than an unstable replacement link.

Direct Review links keep their `/reviews/<id>` route but are normalized onto the
canonical origin. A second app launch focuses and navigates the existing window.
External non-loopback links open in the system browser.

When the shell owns the daemon, it holds the `--exit-on-stdin-close` pipe and
explicitly stops the child during normal shutdown. If that child crashes, the
shell retries up to three times per minute. When another Diffect process owns the
daemon, the shell attaches without taking ownership of its lifecycle.

```sh
mise run desktop        # build the monorepo, then launch the app
```

The development build runs `packages/core/dist/daemon-bin.js` with the system
Node. A packaged build uses `scripts/build-sidecar.mjs` to create a self-contained
Node SEA sidecar and bundles `packages/web/dist` as a resource:

```sh
mise run desktop:bundle
```

For UI work with hot reload, point the shell at Vite instead of the built web
assets:

```sh
mise run daemon         # terminal 1: clean API on :7421
mise run dev            # terminal 2: Vite on :5173, proxying /api
mise run desktop:dev    # terminal 3: Tauri window on the Vite origin
```

`desktop:dev` sets `DIFFECT_DESKTOP_URL=http://127.0.0.1:5173`.
