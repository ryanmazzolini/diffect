# Diffect

Local-first code review. Review state is a local append-only event log under
`~/.config/diffect/` — no database, no account, no server-owned automation — so
the browser UI, the CLI, and agents are equal peers over the same files.

- **`diffectd`** — serves the browser review UI and a JSON/SSE API from the
  machine where your repos live.
- **`diffect`** — the CLI; reads and writes the store directly, with or without
  the daemon running.

## What it does

Review one or more git repos across one or more workspaces at once — add them from
the sidebar dialog, which suggests recent projects from your Claude Code / pi
sessions and includes an in-app folder browser (worktrees included). A collapsible
file tree shows per-file diffstats; pick any target — `work`, `staged`, `unstaged`,
a ref, or a GitHub-style base↔compare range. The diff is syntax-highlighted, with
light/dark themes (following your OS by default), sticky file headers, unfoldable
context, and a resizable thread pane.

Comment on a line, a click-or-keyboard-selected range, or **any file in the repo**
(not just the changed ones, via a picker — it surfaces as an out-of-diff block).
The composer is GitHub-style markdown with write/preview and image attachments;
comments re-anchor as the code changes and are flagged *stale* when their range
disappears — never silently dropped. Close or delete threads; mark
files viewed; navigate with `j`/`k`. The browser updates live over SSE and can open
a `file:line` in your editor. The same threads are available to an agent through
the event log.

Not yet built: AI review passes, GitHub sync, and auth for remote access.

## Layout

```
packages/
  shared/  contract types shared by daemon, CLI, and web UI
  core/    diffect CLI + diffectd daemon + git diff + central event log
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
diffect resolve <id> --summary "…"            # closes the thread
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

## Where reviews live

Review state is a per-user store at `$XDG_CONFIG_HOME/diffect/` (default
`~/.config/diffect/`): one append-only `threads.jsonl` per repo, keyed by the
repo's path, plus a `workspaces.json` registry of known workspace paths. It's
plain local files — host-private, not committed with your code, and equally
readable/writable by the CLI, the daemon, and agents. A legacy in-tree
`.reviews/threads.jsonl` from older versions is migrated into the store on first
access (the original is left as a backup).

## Networking

`diffectd` binds to `127.0.0.1` (override with `--host`). There is no auth yet, so
only expose it inside a trusted network (e.g. a Tailscale interface) for
phone/remote review.

## Related projects

- [**diffity**](https://diffity.com) by [Kamran Ahmed](https://kamranahmed.se) — a
  GitHub-style git diff viewer in the browser. Diffect's diff view is modeled on
  it, then adds a local-first review layer (the event log) shared by the CLI and
  agents.
