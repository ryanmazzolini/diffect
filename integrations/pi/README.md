# Diffect ⇄ pi

Diffect review state is a local append-only event log under
`$XDG_CONFIG_HOME/diffect/` (default `~/.config/diffect/`). The CLI, daemon, UI,
and agents are equal peers over those files.

## Slash command

Install this local pi package, then `/reload` and use:

```text
/diffect
```

It resolves the installed desktop launcher, synchronously ensures the persistent
Diffect UI/API service at `http://127.0.0.1:13433`, registers the workspace, and
opens Diffect at:

```text
/?repo=<repo>&worktree=<worktree>&target=work
```

Workspace resolution is daemon-owned. Pi sends its native session ID, session
file, session cwd, and current cwd to `POST /workspace-resolution`. Diffect then
checks enabled sources in settings order, prefers saved external-workspace
bindings and exact agent-session matches, validates every candidate through the
same workspace discovery path, and falls through when a provider is unavailable.
An explicit `--workspace` path remains the highest-priority override.

When equally ranked candidates remain, interactive commands show a picker.
`/diffect-space` asks the daemon for a manual choice without applying the current
binding, then forces the picker. Cancelling preserves the binding; choosing an
external workspace replaces it with a durable Diffect settings binding rather
than a Pi session entry. Existing `diffect-workspace` session entries are not
migrated or deleted, but new entries are no longer written. Use `/diffect
staged`, `/diffect unstaged`, or `/diffect main..feature` to open a specific
review target.

Use `/diffect-review` to ask the agent to read open Diffect feedback for the
inferred workspace. Use `/diffect-review proactive` to ask it to inspect changes
and leave Diffect comments without editing files.

## Feedback watch

Connect the current Pi session after choosing the workspace:

```text
/diffect-connect
```

The first connection is explicit. It reuses or starts `diffectd` without opening
another application window, then reconnects automatically when this Pi session
reloads, resumes, or forks. The daemon resolver's validated workspace is
authoritative; terminal focus alone does not override an exact session match or
saved binding.

By default, only new user-authored threads and replies trigger the agent. Existing
feedback becomes the connection baseline and does not trigger a turn. Events are
filtered and batched before the model runs, and the agent receives only the
affected thread ids.

For a conductor that should also receive feedback from other agents:

```text
/diffect-connect --agent conductor --include-agents
```

Each Pi session adds a short session suffix to its author label, such as
`conductor/1a2b3c4d`. Conductor mode ignores that exact identity while accepting
other named agents. Use `--users-only` to return to user-only feedback.

Stop automatic feedback turns with:

```text
/diffect-disconnect
```

Short connection interruptions replay a bounded set of recent feedback events.
Feedback received while the daemon is fully stopped is not replayed automatically.
Use `/diffect-review` as the manual fallback. The watch is independent of Herdr,
Ghostty, and other terminal hosts.

Daemon management uses one synchronous launcher in this order:

- `DIFFECT_APP_PATH=/path/to/diffect-desktop`, when explicitly set
- `diffect-desktop` on `PATH`, including a package-manager installation
- the authoritative launcher recorded by a prior installed desktop launch

The selected launcher runs `daemon ensure --json`. It reuses only the exact
installed build, starts the service when absent, and reports build mismatches or
a non-Diffect `13433` listener instead of starting a private daemon or choosing
another port. The desktop single-instance hook focuses and navigates an existing
window. If no desktop window can be opened, `/diffect` still returns the stable
browser URL.

For source development, start `diffectd` explicitly and set `DIFFECT_URL` to its
UI/API origin. Source checkouts never claim the production daemon implicitly.

For global use:

```sh
pi install /path/to/diffect/integrations/pi
```

Put the `diffect` CLI on `PATH` or run the integration from a built Diffect checkout.
The managed daemon comes from the installed desktop release.

## Agent tools

The extension also registers minimal tools:

```text
diffect_open
diffect_list_feedback   # optional ids array limits output to affected threads
diffect_comment
diffect_reply
diffect_resolve
diffect_pr
```

The normal loop stays boring:

```sh
diffect list --status open --json
# fix code
diffect reply <thread-id> --agent pi --body "Fixed by ..."
diffect resolve <thread-id> --agent pi --summary "Fixed in this change."
```

Agents can create their own normal comments too:

```sh
diffect comment --file src/api.ts --line 42 --severity must-fix \
  --agent pi --body "This dereferences a possibly-null user."
```

`diffect_pr` reads or updates the local PR Draft packet. Pass `repo` in multi-repo workspaces:

```json
{ "action": "update", "repo": "web", "title": "Fix auth redirect", "body": "## Summary\n..." }
```

No apply daemon, no cloud runner, no separate AI findings store.
