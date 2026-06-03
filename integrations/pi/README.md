# Diffect ⇄ agent integration (pi / Claude / Codex)

Diffect's review state is an append-only event log at `<workspace>/.reviews/threads.jsonl`.
The `diffect` CLI reads and writes it directly, so an agent can participate in a
review **whether or not the `diffectd` daemon is running** — no API, database, or
daemon orchestration required.

This is the *first* agent-integration model: the agent runs normal `diffect`
commands. There is intentionally **no** built-in "apply" loop or daemon-owned
autonomous fixing — the coding agent owns implementation; Diffect just exposes
review state and stable commands.

## The loop

1. **List open feedback** the human (or another agent) left:
   ```sh
   diffect list --status open --json
   ```
   Each thread has a stable `id`, a `file`/`line` (or `null` for general
   threads), a `severity`, and an ordered `comments` array. An `anchorState` of
   `"stale"` means the code under the comment moved or was removed — surface it,
   don't ignore it.

2. **Make the fix** in the working tree (your normal editing tools).

3. **Reply to the thread** explaining what you did, authored as an agent:
   ```sh
   diffect reply <thread-id> --agent pi --body "Batched the N+1 via a dataloader."
   ```

4. **Resolve** (closes the thread):
   ```sh
   diffect resolve <thread-id> --agent pi --summary "Fixed in this change."
   ```
   Always pass a `--summary` — a status change with no explanation is lost
   context. Diffect records it as a trailing comment on the thread.

5. **Raise your own findings** as normal review threads (no separate "AI findings"
   store — they show up in the same inbox as human comments, distinguished only by
   the author chip):
   ```sh
   diffect comment --file src/api.ts --line 42 --severity must-fix \
                   --agent pi --body "This dereferences a possibly-null user."
   diffect general --agent pi --body "Overall: consider extracting the auth guard."
   ```

## Output contract

Every mutating command prints the resulting thread as pretty JSON on stdout, so
you can parse the new `id`/`status` programmatically. `diffect list --json` and
`diffect diff --json` are stable, machine-readable surfaces meant for skills and
extensions — prefer them over scraping human output.

## Notes

- `--agent NAME` sets `author.type:"agent"` with that name. Omit it and the
  comment is authored as the user.
- `--repo` defaults to the single repo in the workspace; pass it explicitly in a
  multi-repo workspace (Slice 4).
- The CLI resolves the workspace by walking up from the current directory to the
  nearest `.reviews/` folder, then falling back to the git root. Run it from
  inside the workspace.
