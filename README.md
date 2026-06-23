# Diffect

[![CI](https://github.com/ryanmazzolini/diffect/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanmazzolini/diffect/actions/workflows/ci.yml)

Local-first code review. Review state is a local append-only event log under
`~/.config/diffect/` — no database, no account, no server-owned automation — so
the browser UI, the CLI, the desktop app, and agents are equal peers over the
same files.

## Status

Diffect is pre-1.0. It is useful for local review today, but the public release
surface is still settling.

Built:

- **`diffectd`** — serves the browser review UI and a JSON/SSE API from the
  machine where your repos live.
- **`diffect`** — the CLI; reads and writes the review store directly.
- **Diffect Desktop** — a Tauri shell that starts a private local daemon.
- **pi integration** — opens Diffect from pi and lets agents read/write review
  threads.

Not built yet: AI review passes, GitHub sync, remote auth, signed/notarized
desktop releases, and auto-updates.

## What it does

Review one or more git repos across one or more workspaces at once — add them
from the sidebar dialog, which suggests recent projects from Claude Code / pi
sessions and includes an in-app folder browser (worktrees included). A
collapsible file tree shows per-file diffstats; pick any target — `work`,
`staged`, `unstaged`, a ref, or a GitHub-style base↔compare range.

Comment on a line, a selected range, or any file in the repo. The composer is
GitHub-style markdown with write/preview and image attachments. Comments
re-anchor as code changes and are flagged *stale* when their range disappears —
never silently dropped. Close or delete threads; mark files viewed; navigate
with `j`/`k`. The browser updates live over SSE and can open `file:line` in your
editor.

## Layout

```text
packages/
  shared/   contract types shared by daemon, CLI, and web UI
  core/     diffect CLI + diffectd daemon + git diff + event log
  web/      React + Vite browser UI served by diffectd
  desktop/  Tauri shell over a private diffectd
  e2e/      Playwright coverage
integrations/
  pi/       local pi package and tools
```

## Run from source

Tooling is pinned with [mise](https://mise.jdx.dev). Dependencies install with
lifecycle scripts disabled and a 3-day npm release-age cooldown.

```sh
mise install
pnpm install
mise run daemon -- --workspace /path/to/repo
# open http://127.0.0.1:7421
```

`--workspace` defaults to the current directory. Drop it to review the repo
you're standing in.

For the desktop app:

```sh
mise run desktop
```

For UI hot reload:

```sh
mise run daemon   # terminal 1
mise run dev      # terminal 2
```

## CLI

Until packages are published, alias the built CLI from a checkout:

```sh
pnpm build
alias diffect="node /path/to/diffect/packages/core/dist/cli.js"

cd /path/to/repo
diffect list --status open
diffect comment --file src/a.ts --line 42 --severity must-fix --body "…"
diffect reply <id> --agent pi --body "fixed"
diffect resolve <id> --summary "fixed in this change"
```

The default target is `work` (committed-since-base + unstaged + untracked). Pick
another with `--target staged|unstaged|<ref>|<a>..<b>`, and a specific checkout
with `--repo`/`--worktree`.

## Develop

```sh
pnpm build
pnpm --filter @diffect/e2e test
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor notes and
[integrations/pi](integrations/pi/README.md) for agent usage.

## Where reviews live

Review state is a per-user store at `$XDG_CONFIG_HOME/diffect/` (default
`~/.config/diffect/`): one append-only `threads.jsonl` per repo, keyed by the
repo's path, plus a `workspaces.json` registry of known workspace paths. It's
plain local files — host-private, not committed with your code, and equally
readable/writable by the CLI, the daemon, desktop, and agents.

A legacy in-tree `.reviews/threads.jsonl` from older versions is migrated into
the store on first access; the original is left as a backup.

## Networking and security

`diffectd` binds to `127.0.0.1` by default. There is no auth yet, so only expose
it inside a trusted network if you override `--host`. Report vulnerabilities
privately; see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

## Related projects

- [diffity](https://diffity.com) by [Kamran Ahmed](https://kamranahmed.se) — a
  GitHub-style git diff viewer in the browser. Diffect's diff view is modeled on
  it, then adds a local-first review layer shared by the CLI and agents.
