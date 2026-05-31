# Diffect core — API surface & data model

Resolved name: product/CLI = `diffect`, web/API daemon = `diffectd`. `review` may remain a local/user alias, but should not be the public product or package name.

## Shape

`diffectd` runs **where the repos live** (your Linux box, a Mac, wherever). You point it at a workspace folder; it discovers the git roots under that folder, computes diffs, and serves a JSON/SSE API plus the web client. The **source of truth for comments is a folder on disk** (`<workspace>/.reviews/`), not the running process — so an agent can read and write reviews with the daemon down, and three frontends (Linux/Mac/web on phone) all see the same state. herdr is optional: it just resolves a workspace name to a folder and launches `diffectd` pointed at it.

## Concepts

- **Workspace** — a folder (your `ticket/repo-worktrees/` layout). The review unit. Maps to one feature / vertical slice.
- **Repo** — a git root discovered under the workspace.
- **Worktree** — a checkout of a repo. A repo may have several (the adversarial A/B case). Grouped by shared git common-dir.
- **Change** — the diff for one worktree against its base.
- **Thread** — an anchored discussion on a line/range (or `__general__`). Holds ordered comments.
- **Comment** — one message in a thread; `author.type` is `user` or `agent`.
- **Tour** — a later add-on: an ordered set of chapters over the workspace diff (the offline "guided review"). Not part of the review-first MVP.

### Discovery rules

1. Walk the workspace dir for git roots (depth 1–2 covers `ticket/repo-worktrees/`).
2. For each root, detect `.git` **dir** (primary) vs `.git` **file** (worktree); group worktrees sharing a `commondir`. Two+ worktrees of one repo ⇒ render as an A/B group.
3. Resolve each worktree's base: `merge-base(<default-branch>, HEAD)`. Default branch from `origin/HEAD`, overridable per workspace.
4. Comparison basis (default): `work` — the whole workspace slice, meaning committed-since-base plus unstaged and untracked work, so in-flight agent work shows. Exposable as focused targets later (`staged`, `unstaged`, `base..head`, `HEAD~3`, `--cached`).

## On-disk format — `<workspace>/.reviews/`

One store per workspace, naturally cross-repo. Suggested layout:

```
.reviews/
  threads.jsonl     # append-only event log (create/comment/resolve/dismiss)
  tours/<id>.json   # later add-on: generated guided reviews
  state.json        # cursor/meta (schema version, last base shas per repo)
```

`threads.jsonl` is append-only (last-write-wins on replay), which is merge-friendly and trivially diffable. A thread, after replay:

```jsonc
{
  "id": "th_8f2a",
  "repo": "api",                       // relative to workspace root
  "worktree": "feat-presence",         // which checkout; null if single
  "file": "app/graphql/types/presence_type.rb",
  "side": "new",                       // "new" | "old"
  "line": 42,
  "endLine": 47,                       // optional range
  "anchor": {                          // re-anchoring after edits (the GitLab lesson)
    "baseSha": "a1b2c3d",
    "contextHash": "sha256:…",         // hash of N lines around the anchor
    "hunkSnippet": "def resolve_presence…"
  },
  "severity": "must-fix",              // must-fix | suggestion | nit | question | null
  "status": "open",                    // open | resolved | dismissed
  "comments": [
    { "id":"c1", "author":{"type":"user"},  "body":"N+1 on members", "ts":"…" },
    { "id":"c2", "author":{"type":"agent","name":"pi"}, "body":"Batched via dataloader", "ts":"…" }
  ]
}
```

**Re-anchoring:** on load, try `(file, side, line)` against the current diff; if the line moved, locate by `contextHash` / `hunkSnippet`; if neither matches, mark the thread `stale` (still shown, flagged) rather than dropping it.

## Daemon HTTP API

JSON over HTTP, one workspace per daemon instance (or `/workspaces/:id` if you host several).

```
GET  /workspace                      → { id, root, base, repos:[…] }   workspace + inbox summary
GET  /repos/:repo                    → { worktrees:[…], pr? }          per-repo, incl. A/B worktrees
GET  /repos/:repo/diff
       ?worktree=&base=&untracked=   → { files:[ { path, status, hunks:[ { lines:[ {side,old,new,type,text,structural} ] } ] } ] }
GET  /repos/:repo/pr                 → { url, state } | null           detect-and-link only

# threads (thin wrapper over the .reviews/ store)
GET  /threads?status=open            → [ thread ]                      cross-repo by default
POST /threads                        { repo, worktree, file, side, line, endLine?, severity?, body }
POST /threads/:id/comments           { author, body }
POST /threads/:id/resolve            { summary? }
POST /threads/:id/dismiss            { reason? }

# Later add-ons after core human review + fix loop is excellent:
# POST /ai-review                    { scope?, prompt? }→ { added:[thread_id] }  agent review pass
# POST /tour                         { scope? }        → { id, chapters:[…] }   guided review

# agent fix loop
# Initial model is skill/extension-driven, Diffity-style: agents read open threads
# and call the Diffect CLI directly. Do not make daemon-owned apply orchestration
# part of the first product shape.
# Possible later add-on:
# POST /apply                        { threads?:[id] } → hands open threads to the workspace agent

# live updates
GET  /events  (SSE)                  → diff.changed | thread.added | thread.updated | tour.ready
```

`structural: true` on a diff line marks formatting-only / noise (tree-sitter, AST-level). The client toggles these; nothing is dropped server-side.

`/events` is driven by an fs-watcher on the worktrees and on `.reviews/` — that's the offline "realtime updates": agent edits and new threads appear inline without reload.

## Agent CLI shim

The file store means agents work **without the daemon running**. The CLI reads/writes `.reviews/` directly; the GUI and CLI are peers. Initial agent integration should be Diffity-style skills/extensions that read open threads, create agent-authored threads, reply/resolve, and call Diffect commands, not built-in daemon orchestration.

```
diffect diff [--worktree W] [-- <git-diff-args>]
diffect list [--status open|resolved|dismissed] [--json]
diffect comment --repo R [--worktree W] --file F --line N [--end-line M] \
                [--side new|old] [--severity must-fix|suggestion|nit|question] --body "…"
diffect general --repo R --body "…"
diffect reply <thread-id> --body "…"
diffect resolve <thread-id> [--summary "…"]
diffect dismiss <thread-id> [--reason "…"]
# Later add-ons after core human review + fix loop is excellent:
# diffect ai   [--scope …] [--prompt] # AI review pass → agent-authored threads
# diffect tour [--scope …]            # generate a guided review (pi -p)
```

### `pi -p` integration (later)

AI features are follow-up add-ons after the core human review + fix loop is excellent. They should use one-shot, non-interactive `pi -p` calls with bundled prompts; output is parsed into normal thread or tour schemas. No persistent agent session required.

- **AI review** — feed the diff; ask for inline findings as `diffect comment …` calls (or JSON the CLI ingests), tagged with severity. They land as `author.type:"agent"` threads, indistinguishable in the UI from yours except by the author chip — so you triage human + AI findings in one inbox.
- **Guided tour** — feed the cross-repo diff + file list; ask for ordered chapters (`{ title, why, targets:[{repo,file,line}] }`), core-first then consequences, glue/secondary kept separate. Written to `tours/<id>.json`.

The prompt template lives in the repo (`prompts/tour.md`, `prompts/review.md`) so you can tune it; the daemon just shells out.

## Editor deep-links (open-in-IDE)

The reviewer is not an editor; for edits it hands off to the user's IDE at a file:line, then the watcher refreshes the diff on save. One endpoint, two delivery modes:

```
POST /open   { repo, worktree?, file, line, editor }   # editor optional; falls back to configured default
```

The daemon resolves the absolute host path and acts based on whether the client is co-located with the daemon:

- **Local** (reviewing on the host): daemon runs the editor CLI on the host.
  - Zed `zed <abs>:<line>` · VS Code `code -g <abs>:<line>` · Cursor `cursor -g <abs>:<line>` · JetBrains `idea --line <line> <abs>`
- **Remote** (reviewing from Mac/phone over Tailscale): daemon returns a remote-dev URI the client opens; no CLI on the host.
  - VS Code / Cursor: `vscode://vscode-remote/ssh-remote+<host><abs>:<line>` (`cursor://…` mirrors)
  - JetBrains: Gateway connect link (`jetbrains-gateway://…`)
  - Zed: `zed ssh://<host><abs>` via the local `zed` CLI (Zed has no file URL scheme; needs a local handler)

Direct-from-browser schemes that need no daemon round-trip (when local): `vscode://file/<abs>:<line>:<col>`, `cursor://file/<abs>:<line>`, `idea://open?file=<abs>&line=<line>`. Zed is CLI-only, so it always goes through `/open` or a registered local handler.

**Detection:** daemon probes `which zed code cursor idea` on the host to populate the editor list; the user picks a default + local/remote target (persisted per workspace). The round-trip is closed by the existing `/events` watcher — `diff.changed` fires on save, the open threads re-anchor, and the reviewer updates without a reload.

## GitHub

Detect only. If a worktree's branch has an open/draft PR (via `gh` or the API when a token's present), surface a link-out. No sync, no mirroring — your gate is upstream of the PR.

## Notes / open seams

- **A/B** is a grouping, not a mode: the daemon returns 2+ worktrees for a repo; the client offers side-by-side + a "pick winner" affordance (which can `git worktree remove` the loser, optionally).
- **Horizontal slices** (creds → schema → API → frontend): a `slice` tag on threads/chapters lets you filter the cross-repo view down to one future-PR's worth.
- **Auth/remote**: daemon binds to the Tailscale interface; no auth needed inside the tailnet, add a token if you ever expose it wider.
