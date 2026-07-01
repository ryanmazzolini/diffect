import { memo } from "react";
import type { Thread } from "@diffect/shared";
import { ThreadConversation } from "./ThreadConversation.js";

// Memoized: the thread pane shouldn't re-render when only the diff/sidebar or an
// unrelated bit of app state changed — only when its own thread list does.
export const ThreadList = memo(function ThreadList({
  threads,
  showRepo = false,
  onChanged,
  onNavigate,
}: {
  threads: Thread[];
  /** Show the repo (and worktree) on each card — used for the cross-repo inbox. */
  showRepo?: boolean;
  onChanged: () => void;
  onNavigate?: (thread: Thread) => void;
}) {
  if (threads.length === 0) {
    return (
      <div className="thread-list-empty">
        No threads here. Comment on the space/repo above, or hover a line and click
        <strong>+</strong>.
      </div>
    );
  }
  return (
    <div className="thread-list">
      <h2>Threads</h2>
      {threads.map((t) => (
        <div className={`thread-card status-${t.status}`} key={t.id}>
          <div className="thread-card-head">
            {t.repo === null && t.spacePath && <span className="repo-chip">space</span>}
            {showRepo && t.targetLevel !== "space" && t.repo && (
              <span className="repo-chip">
                {t.repo}
                {t.worktree ? ` · ${t.worktree}` : ""}
              </span>
            )}
            <span className="loc">{threadLocation(t)}</span>
          </div>
          <ThreadConversation
            thread={t}
            onChanged={onChanged}
            onNavigate={t.file ? () => onNavigate?.(t) : undefined}
          />
        </div>
      ))}
    </div>
  );
});

function threadLocation(t: Thread): string {
  if (t.file) return `${t.file}:${t.line ?? "?"}`;
  if (t.targetLevel === "space") return "space";
  return "repo";
}
