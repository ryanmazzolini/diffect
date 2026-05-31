# Diffect

A local-first code review tool. Canonical review state lives in a workspace-local
`.reviews/` folder — not a database, profile, or daemon process — so the browser
UI, the CLI, and agents are all peers over the same on-disk store.

- **`diffect`** — the CLI. Reads and writes `.reviews/` directly; works whether
  or not the daemon is running.
- **`diffectd`** — the web/API daemon. Serves the browser review UI plus a
  JSON/SSE API from the machine where the repos live.

This repo is built in vertical slices; see
[`.plans/2026-05-31-diffect-review-mvp/plan.md`](.plans/2026-05-31-diffect-review-mvp/plan.md).

## Status — Slice 1: first durable workspace comment

A reviewer can open a single-repo workspace on the default `work` target, leave
the first inline comment from the browser, and read it back from the CLI with the
daemon stopped.

## Layout

```
packages/
  shared/   TS contract types shared by the daemon, CLI, and web UI
  core/     diffect CLI + diffectd daemon + git diff + .reviews/ event log
  web/      React + Vite browser review UI (served by diffectd)
```

## Develop

Tooling is pinned with [mise](https://mise.jdx.dev) (`node`, `pnpm`); deps use
pnpm with lifecycle scripts blocked by default and a 3-day release-age cooldown
(`.npmrc`) as supply-chain hardening.

```sh
mise install        # node + pnpm
pnpm install

# Build (shared must build before core/web resolve @diffect/shared):
pnpm -C packages/shared build
pnpm -C packages/core   build
pnpm -C packages/web    build

pnpm -r --filter @diffect/core test    # vitest fixtures (real git repos)
```

## Try it

```sh
# Build, then point the daemon at any git repo:
node packages/core/dist/daemon-bin.js --workspace /path/to/repo --port 7421
# open http://127.0.0.1:7421, comment on a line, then with the daemon stopped:
cd /path/to/repo && node /path/to/diffect/packages/core/dist/cli.js list --status open --json
```

The default review target is **`work`**: everything changed for the slice —
committed-since-base, unstaged, and untracked.
