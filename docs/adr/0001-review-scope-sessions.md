# Use review scopes, snapshots, and sessions for timeline identity

Accepted: 2026-06-09

Diffect will use **Review Scope** as the product-facing model for what is being reviewed, while keeping raw target specs like `work`, `staged`, and `base...compare` as internal Git query serialization. Review threads will be associated with a durable Review Session and Review Scope Snapshot so comments made against different HEAD/index/worktree states remain distinguishable.

## Considered options

- Key threads only by repo/worktree/file/line/anchor. This is too ambiguous for staged/unstaged changes across commits or across multiple staged snapshots on the same commit.
- Treat the whole current branch as the review timeline. This approximates PRs on feature branches, but it makes long-lived/default branches like `main` accumulate unrelated review history.

## Consequences

- Non-default branches can automatically get PR-like branch-wide sessions bounded by their fork point or merge-base with the default branch.
- Default or long-lived branches need bounded active sessions or explicit ranges, and can complete/archive when the workspace is clean and no open threads remain.
- Legacy threads without scope/session metadata must remain visible as legacy/unscoped rather than disappearing.
