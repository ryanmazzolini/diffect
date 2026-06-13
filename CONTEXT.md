# Diffect Context

Diffect is a purpose-built local review app for personal code review workflows. It keeps canonical review state in a workspace-local `.reviews/` folder rather than in profiles, a database, or Chord storage.

## Language

**Diffect**:
A local-first review app whose durable state lives in `.reviews/` next to the work being reviewed.
_Avoid_: Diffective, Divv, Chord surface, profile-backed workbench, database-backed review system

**diffectd**:
The web/API daemon for serving the Diffect browser UI, JSON API, live events, and editor handoff from the machine where the workspace repos live.
_Avoid_: source of truth, required store writer, Chord backend, profile service

**Review Folder**:
The workspace-local `.reviews/` directory that is the canonical store for review sessions, targets, threads, comments, and anchoring metadata.
_Avoid_: profile store, global database, generated cache

**Review Folder Visibility**:
A user or workspace policy that decides whether `.reviews/` is private/gitignored or committed/shared.
_Avoid_: hard-coded private-only storage, mandatory committed review state

**Thread Event Log**:
The append-only `.reviews/threads.jsonl` file that canonically records review thread creation, replies, resolution, dismissal, and edits.
_Avoid_: mutable thread files as the primary store, daemon-only state, generated cache as source of truth

**Review Scope**:
The user-facing description of what is being reviewed, such as All local changes, Staged changes, Unstaged changes, or a base/compare branch range.
_Avoid_: exposing `work` jargon, raw git range syntax as the primary UI, PR-only review command

**Review Scope Snapshot**:
The exact Git state captured for a Review Scope at a moment in time, including enough HEAD, index, worktree, and base/compare identity to distinguish later review iterations.
_Avoid_: line-only identity, treating all staged changes on a branch as the same review state

**Review Session**:
A durable review record that groups review scope snapshots, timeline entries, and open/closed/outdated Review Threads over time.
_Avoid_: one session per file edit, whole-default-branch history, Chord Workspace Review

**Review Target Spec**:
An internal serialization for querying Git diffs, such as `work`, `staged`, `unstaged`, `main`, `HEAD~1`, or `main..feature`.
_Avoid_: user-facing product language, durable review identity by itself

**Review Target**:
The normalized Git query state for a Review Target Spec, such as working tree, staged changes, unstaged changes, branch comparison, or commit range.
_Avoid_: durable session identity, only branch, only pull request

**Review Thread**:
A comment conversation attached to a selected file range in a review session.
_Avoid_: memory, task, generic note

**File Hash**:
A hash of the reviewed file content used as a staleness signal for review threads.
_Avoid_: sole comment anchor, whole-file invalidation rule

**Anchor Hash**:
A hash of the selected commented range used to decide whether a review thread is still anchored after the file changes.
_Avoid_: relying only on line number, relying only on whole-file hash

**Outdated Review Thread**:
A review thread whose file changed and whose anchor range can no longer be found, causing it to fall out of the active review path.
_Avoid_: deleting the comment, silently hiding unresolved feedback

**Guided Tour**:
A later add-on that explains a workspace diff in an ordered narrative after the core review workflow is excellent.
_Avoid_: MVP requirement, separate feedback system, replacement for inline review threads

**AI Review Pass**:
A later add-on where an agent creates normal review threads from a diff after the human review and fix loop is excellent.
_Avoid_: MVP requirement, separate AI finding store, substitute for human review ergonomics

**Agent Skill Integration**:
The initial agent integration model where pi/Claude/Codex skills or extensions read open review threads, reply to threads, create agent-authored threads, and run normal Diffect CLI commands.
_Avoid_: built-in agent orchestration, daemon-owned apply loop, hidden autonomous fixing

**Agent-authored Review Thread**:
A normal Review Thread created by an agent through the CLI or skill/extension, not a separate AI review data type.
_Avoid_: separate agent findings store, hidden review notes, automatic AI review pass as MVP requirement

**Agent Reply**:
A normal comment added by an agent to an existing Review Thread, usually explaining a fix or asking for clarification.
_Avoid_: status-only resolution with no explanation, separate apply log

## Relationships

- **diffectd** serves the web version of **Diffect** and reads/writes the same **Review Folder** as the CLI.
- A **Review Folder** contains the canonical **Thread Event Log**.
- The **Thread Event Log** is append-only so CLI, agents, and **diffectd** can cooperate without a database.
- A **Review Folder** contains many **Review Sessions**.
- **Review Folder Visibility** is chosen by the user or workspace; Diffect supports private and committed `.reviews/` folders.
- A user opens **Diffect** by choosing a **Review Scope** rather than by typing raw git syntax or manually creating a **Review Session**.
- The default **Review Scope** is All local changes.
- A **Review Scope** produces one or more **Review Scope Snapshots** as HEAD, index, or worktree state changes.
- A **Review Session** records durable timeline state for one bounded review, including **Review Scope Snapshots** and **Review Threads**.
- A **Review Scope Snapshot** can be translated into a **Review Target Spec** and normalized **Review Target** for diff computation.
- A **Review Session** contains many **Review Threads**.
- A **Review Thread** stores a **File Hash** as a staleness signal and an **Anchor Hash** as the active anchoring check.
- A file change does not automatically invalidate every **Review Thread** in that file.
- A **Review Thread** remains active when its selected range still matches after file changes.
- A **Review Thread** becomes an **Outdated Review Thread** when the selected range can no longer be found.
- A **Guided Tour** may reference review targets and files, but it does not own review feedback.
- An **AI Review Pass** creates normal **Review Threads** and does not introduce a separate feedback model.
- **Agent Skill Integration** is the first fix-loop path; Diffect exposes review state and commands, while the coding agent owns implementation.
- An **Agent Reply** and an **Agent-authored Review Thread** are both normal review comments in the **Thread Event Log**.

## Example dialogue

> **Dev:** "If I reorder imports in a file, should every comment in that file disappear from the review?"
> **Domain expert:** "No. Use the file hash as a staleness signal, but only let the thread fall away when the commented range no longer matches."

## Flagged ambiguities

- `.reviews/` is canonical review state, not a cache around Chord or Diffity.
- `.reviews/` visibility is user-chosen; do not assume it is always gitignored or always committed.
- Whole-file hash invalidation was considered too brittle; the resolved rule is range-based anchoring with file-hash staleness detection.
- The resolved user model is scope-first: UI should use All local changes, Staged, Unstaged, and base/compare language while raw Review Target Specs remain internal git-query serialization.
- The default review scope is All local changes: everything changed for the workspace slice, not only unstaged files.
- Automatic branch-wide timelines are for non-default branches; default or long-lived branches use explicit ranges or bounded Review Sessions instead of the whole branch history.
- The canonical review-thread store is append-only `.reviews/threads.jsonl`, not mutable per-thread files or daemon memory.
- Reviews are primary; **Guided Tours**, **AI Review Passes**, and other explanatory/agent-generated workflows are follow-up add-ons after the human review and fix loop is excellent.
- Do not make `apply` or daemon-owned agent orchestration part of the initial model; prefer Diffity-style skills/extensions that consume Diffect review state.
- Agent-created threads and agent replies are allowed as CLI primitives; the deferred feature is an automatic **AI Review Pass**, not the ability for agents to write comments.
