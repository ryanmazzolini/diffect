# Diffect Context

Diffect is a local-first review tool and protocol for agent-produced software work. Its durable product unit is a **Thread**: one bounded piece of work with diffs, reviews, comments, artifacts, evidence, and acceptance state.

Diffect does **not** own cloud agent orchestration. Pi composes integrations: a `pi-diffect` extension talks to Diffect, and a separate `pi-flue` extension can talk to Flue/Cloudflare or any other runner.

## Language

**Diffect**:
A local-first app/protocol for reviewing and controlling software work.
_Avoid_: cloud IDE, generic agent platform, OpenHands clone, Flue frontend, runner orchestrator

**diffectd**:
The local web/API daemon for the Diffect UI, JSON API, live events, editor handoff, and agent-facing review protocol.
_Avoid_: cloud runner, source of truth by itself, hidden autonomous fixer

**Thread**:
The durable top-level unit of review/control. Reviews, comments, artifacts, evidence, and agent-produced results attach to a Thread.
_Avoid_: terminal session, PR-only object, comment conversation, generic note

**Thread State**:
The local-first metadata/events/blobs for a Thread. It remains host-local unless the user explicitly exports, syncs, or imports it through an integration.
_Avoid_: always-synced database, mandatory committed folder, cache only

**Storage/Profile Policy**:
The project/user policy deciding whether Thread state stays local-only, can be exported, or may use approved remote storage.
_Avoid_: sending work data to personal Cloudflare by default

**Review**:
A scoped review of branch/commit/diff state inside a Thread.
_Avoid_: top-level work item, comment thread

**Review Scope**:
The user-facing description of what is being reviewed: All local changes, Staged changes, Unstaged changes, or a base/compare branch range.
_Avoid_: raw git range syntax as primary UI, PR-only review command

**Review Scope Snapshot**:
The exact Git state captured for a Review Scope at a moment in time, including enough HEAD, index, worktree, and base/compare identity to distinguish later iterations.
_Avoid_: line-only identity, treating all staged changes on a branch as the same review state

**Review Target Spec**:
An internal serialization for querying Git diffs, such as `work`, `staged`, `unstaged`, `main`, `HEAD~1`, or `main..feature`.
_Avoid_: user-facing product language, durable review identity by itself

**Review Target**:
The normalized Git query state for a Review Target Spec: working tree, staged changes, unstaged changes, branch comparison, or commit range.
_Avoid_: durable Thread identity, only branch, only pull request

**Review Guide**:
A Linear-style ordered walkthrough of a diff: core change first, consequences next, risky areas, generated/noise/supporting changes, and evidence.
_Avoid_: separate feedback system, replacement for comments, MVP blocker for basic review

**Review Comment**:
Feedback attached to a Thread, Review, commit, file, range, or artifact.
_Avoid_: “Review Thread” as a domain term; Thread already means top-level work/control unit

**Comment Conversation**:
Replies and resolution state around a Review Comment.
_Avoid_: top-level Thread, separate AI finding store

**File Hash**:
A hash of reviewed file content used as a staleness signal for comments.
_Avoid_: sole comment anchor, whole-file invalidation rule

**Anchor Hash**:
A hash of the selected commented range used to decide whether a comment is still anchored after file changes.
_Avoid_: relying only on line number, relying only on whole-file hash

**Outdated Comment**:
A comment whose file changed and whose anchor range can no longer be found, causing it to fall out of the active review path.
_Avoid_: deleting the comment, silently hiding unresolved feedback

**Artifact**:
A typed blob/record linked to a Thread, Review, Comment, or imported run result: patch, screenshot, log, transcript, Pi JSONL, preview, design, guide output, or generated UI mockup.
_Avoid_: untyped dumping ground, mandatory cloud upload

**Evidence**:
A human- or agent-provided proof item attached to a Thread: command output, test result, screenshot, review note, artifact, or external run result.
_Avoid_: raw transcript as the only proof

**Acceptance State**:
The human gate for a Thread: accepted, requested changes, skipped review, or pending.
_Avoid_: automatic merge/PR/commit without explicit acceptance or skip

**pi-diffect Extension**:
A Pi extension that exposes Diffect tools to the coding agent: current Thread, feedback list, reply, resolve, add evidence, export context, and import results.
_Avoid_: embedding agent runtime in Diffect core

**pi-flue Extension**:
A separate Pi extension that talks to Flue/Cloudflare or another runner: handoff, run status, cancel, logs, artifacts, cleanup.
_Avoid_: making Diffect depend on Flue

**Handoff Context Export**:
A serializable Diffect package for another tool: Thread metadata, review scope, comments, evidence, artifacts, branch/commit info, and instructions.
_Avoid_: secrets, env files, broad home-directory capture

**Cloud Handoff**:
A Pi-coordinated workflow where `pi-diffect` exports context and `pi-flue` runs work remotely. Results come back to Diffect as comments, evidence, or artifacts.
_Avoid_: Diffect starting/managing cloud agents directly

**Cloud Run**:
An ephemeral execution/data-plane run owned by Flue/Cloudflare/runner tooling. Diffect may display imported status/results, but it is not the runner source of truth.
_Avoid_: canonical Thread state, permanent workspace by default

**AI Review Pass**:
A later add-on where an agent creates normal Review Comments from a diff.
_Avoid_: MVP requirement, separate AI finding store, substitute for human review ergonomics

## Relationships

- **diffectd** serves the local Diffect UI and exposes CLI/API/MCP surfaces for review state.
- A **Thread** is the stable unit of review/control.
- A **Thread** can contain many **Reviews**, **Review Comments**, **Artifacts**, **Evidence** items, and imported run results.
- A **Review** records one bounded look at a **Review Scope** and its **Review Scope Snapshots**.
- A **Review Scope Snapshot** can be translated into a **Review Target Spec** and normalized **Review Target** for diff computation.
- A **Review Guide** orders what to inspect and links to Review Targets, files, ranges, evidence, and comments.
- A **Review Comment** remains active when its selected range still matches after file changes.
- A **Review Comment** becomes an **Outdated Comment** when the selected range can no longer be found.
- **pi-diffect** lets Pi read open comments, reply, create comments, resolve comments, add evidence, export Thread context, and import results.
- **pi-flue** or another runner extension owns cloud execution, status, logs, artifacts, cancellation, and cleanup.
- Cloud handoff uses committed/pushed GitHub branch or commit state; staged and unstaged diffs stay local-only.
- Acceptance state gates commit/PR/merge automation unless explicitly bypassed.

## Flagged ambiguities

- Older docs/code may say `.reviews/`, **Review Session**, or **Review Thread**. Treat those as legacy/current-implementation terms unless a migration plan keeps them deliberately.
- Storage is not settled: options include local SQLite + blobs, per-Thread bundles, or a hybrid. Do not assume Cloudflare can sync a local SQLite DB directly.
- Diffect should export/import explicit context/results; it should not own Flue, Cloudflare Sandbox lifecycle, or agent resume mechanics.
- Work projects must support local-only or work-account-only policies; no work diffs/comments/logs/screenshots/artifacts go to personal Cloudflare by default.
- OpenHands, HumanLayer, Cake, Daytona, and Flue are references/integration targets; do not make Diffect core depend on them.
