# Diffect

Local-first code review. Review state lives in a `.reviews/` folder next to your
code — no database, no account, no server-owned state — so the browser UI, the
CLI, and agents are equal peers over the same files.

- **`diffectd`** — serves the browser review UI and a JSON/SSE API from the
  machine where your repos live.
- **`diffect`** — the CLI; reads and writes `.reviews/` directly, with or without
  the daemon running.

## What it does

Open a workspace of one or more git repos (worktrees included) and review any
target — `work`, `staged`, `unstaged`, a ref, or an `a..b` range. Comments anchor
to a line range, re-anchor as the code changes, and are flagged *stale* when their
range disappears — never silently dropped. The browser updates live over SSE and
can open a `file:line` in your editor. The same threads are available to an agent
through `.reviews/threads.jsonl`.

Not yet built: adding workspaces from the UI, AI review passes, GitHub sync, and
auth for remote access.

## Layout

```
packages/
  shared/  contract types shared by daemon, CLI, and web UI
  core/    diffect CLI + diffectd daemon + git diff + .reviews/ event log
  web/     React + Vite browser UI (served by diffectd)
```

## Run it

```sh
pnpm install
mise run daemon -- --workspace /path/to/repo   # builds, then serves
# → open http://127.0.0.1:7421
```

`--workspace` defaults to the current directory; drop it to review the repo
you're standing in (omitted, `mise run daemon` reviews Diffect itself).

`mise tasks` lists the rest: `dev` (Vite hot-reload UI), `build`, and `test`.

Comment on a line in the browser, then drive the same threads from the CLI. The
CLI runs *inside* the repo you're reviewing, so it's a standalone command rather
than a mise task; until it's published to npm (`npx diffect`), alias it:

```sh
alias diffect="node /path/to/diffect/packages/core/dist/cli.js"

cd /path/to/repo
diffect list --status open                     # what needs attention
diffect comment --file src/a.ts --line 42 --severity must-fix --body "…"
diffect reply <id> --agent pi --body "fixed"   # author as an agent
diffect resolve <id> --summary "…"
diffect dismiss <id> --reason "…"
```

The default target is `work` (committed-since-base + unstaged + untracked). Pick
another with `--target staged|unstaged|<ref>|<a>..<b>`, and a specific checkout
with `--repo`/`--worktree`. See [`integrations/pi/`](integrations/pi/README.md)
for agent notes.

## Develop

Tooling is pinned with [mise](https://mise.jdx.dev); dependencies install with
lifecycle scripts disabled and a 3-day release-age cooldown (`.npmrc`).

```sh
mise install        # node + pnpm
pnpm install
mise run build
mise run test
```

## `.reviews/` visibility

The store is a plain folder beside your code. Gitignore it to keep reviews
private, or commit it to share them — Diffect treats both the same.

## Networking

`diffectd` binds to `127.0.0.1` (override with `--host`). There is no auth yet, so
only expose it inside a trusted network (e.g. a Tailscale interface) for
phone/remote review.

## Related projects

- [**diffity**](https://diffity.com) by [Kamran Ahmed](https://kamranahmed.se) — a
  GitHub-style git diff viewer in the browser. Diffect's diff view is modeled on
  it, then adds a local-first review layer (`.reviews/`) shared by the CLI and
  agents.
