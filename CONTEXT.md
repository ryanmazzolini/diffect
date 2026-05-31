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

**Review Target Spec**:
The user-facing expression for what to review, such as `work`, `staged`, `unstaged`, `main`, `HEAD~1`, or `main..feature`.
_Avoid_: explicit session-first workflow, PR-only review command

**work Target**:
The default Review Target Spec for everything changed in the workspace slice, including committed-since-base, unstaged, and untracked work.
_Avoid_: unstaged-only default, staged-only default, PR-only default

**Review Session**:
A durable internal review record for one review target over time, including open/resolved/outdated review threads as the diff changes.
_Avoid_: user-managed session object, one session per file edit, Chord Workspace Review

**Review Target**:
The normalized Git state under review, such as working tree, staged changes, unstaged changes, branch comparison, or commit range.
_Avoid_: only branch, only pull request

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
- A user opens **Diffect** with a **Review Target Spec** rather than by manually creating a **Review Session**.
- The default **Review Target Spec** is the **work Target**.
- A **Review Target Spec** resolves to one normalized **Review Target**.
- A **Review Session** records durable state for one **Review Target**.
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
- The resolved user model is target-first, following Diffity-like specs such as `work`, `staged`, `unstaged`, and branch/range refs; review sessions are internal durable records, not the primary user concept.
- The default review target is `work`: everything changed for the workspace slice, not only unstaged files.
- The canonical review-thread store is append-only `.reviews/threads.jsonl`, not mutable per-thread files or daemon memory.
- Reviews are primary; **Guided Tours**, **AI Review Passes**, and other explanatory/agent-generated workflows are follow-up add-ons after the human review and fix loop is excellent.
- Do not make `apply` or daemon-owned agent orchestration part of the initial model; prefer Diffity-style skills/extensions that consume Diffect review state.
- Agent-created threads and agent replies are allowed as CLI primitives; the deferred feature is an automatic **AI Review Pass**, not the ability for agents to write comments.
