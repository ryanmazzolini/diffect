# Diffect ⇄ pi

Diffect review state is a local append-only event log under
`$XDG_CONFIG_HOME/diffect/` (default `~/.config/diffect/`). The CLI, daemon, UI,
and agents are equal peers over those files.

## Slash command

Install this local pi package, then `/reload` and use:

```text
/diffect
```

It finds the current Diffect workspace, reuses the running `diffectd` from
`~/.config/diffect/daemon.json` when present (including the Tauri app's ephemeral
port), otherwise starts one, registers the workspace, and opens Diffect at:

```text
/?repo=<repo>&worktree=<worktree>&target=work
```

Workspace choice is session-scoped. The first `/diffect` checks saved session
state, recent absolute paths in the pi session, ticket-worktree spaces shaped
like `.../worktrees/<ticket>/<repo>`, and finally the current directory. If more
than one workspace fits, it shows a picker and saves the choice for the session.

Use `/diffect-space` to change the saved workspace. Use `/diffect staged`,
`/diffect unstaged`, or `/diffect main..feature` to open a specific review
target.

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
reloads, resumes, or forks. Pi's selected workspace is authoritative; Diffect
does not choose another terminal or agent session.

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

It tries the desktop app first:

- `DIFFECT_APP_PATH=/path/to/diffect-desktop`, when set
- the local dev binary at `packages/desktop/src-tauri/target/{debug,release}/diffect-desktop`
- `diffect-desktop` on `PATH`
- macOS app lookup (`open -b app.diffect.desktop`, then `open -a Diffect`)

The desktop app's single-instance hook focuses/navigates the existing window. If
none of those work, it falls back to the browser.

For global use:

```sh
pi install /path/to/diffect/integrations/pi
```

Put `diffect`/`diffectd` on `PATH` or run it from a built Diffect checkout.

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
