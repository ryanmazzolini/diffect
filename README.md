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

## Status — MVP complete (slices 1–5)

A reviewer can open a workspace (one or many repos, including A/B worktrees),
review any target (`work`/`staged`/`unstaged`/a ref/a range), leave durable
anchored comments from the browser, and hand them to an agent through the same
`.reviews/threads.jsonl` the browser uses. Comments survive edited code
(re-anchoring) or surface as *outdated* when their range is gone. The browser
refreshes live over SSE and can hand off a `file:line` to a local editor.

What's intentionally deferred: automatic AI review passes, guided tours, GitHub
sync, daemon-owned `apply` orchestration, and remote auth beyond trusted
local/Tailscale use.

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
committed-since-base, unstaged, and untracked. Other targets:

```sh
diffect diff --target staged          # index vs HEAD
diffect diff --target unstaged        # worktree vs index (+ untracked)
diffect diff --target main..feature   # a commit range
diffect diff --repo api --worktree feat   # a specific repo/worktree
```

### CLI ⇄ agent loop

```sh
diffect list --status open --json                 # what needs attention
diffect comment --file src/a.ts --line 42 --severity must-fix --body "…"
diffect reply <id> --agent pi --body "fixed"      # author as an agent
diffect resolve <id> --summary "…"  ·  diffect dismiss <id> --reason "…"
```

See [`integrations/pi/`](integrations/pi/README.md) for the agent integration
notes.

## `.reviews/` visibility

The review store is a plain folder next to the code. Its visibility is yours to
choose: gitignore it to keep reviews private, or commit it to share them. Diffect
treats both the same — it never assumes one or the other.

## Networking

`diffectd` binds to **`127.0.0.1`** by default (override with `--host`). For
phone/remote review, bind to a Tailscale interface; there is no auth yet, so only
expose it inside a trusted network.
