import type { Thread } from "@diffect/shared";
import { ThreadConversation } from "./ThreadConversation.js";

export function ThreadList({
  threads,
  editors = [],
  showRepo = false,
  onChanged,
}: {
  threads: Thread[];
  editors?: string[];
  /** Show the repo (and worktree) on each card — used for the cross-repo inbox. */
  showRepo?: boolean;
  onChanged: () => void;
}) {
  if (threads.length === 0) {
    return (
      <div className="thread-list-empty">
        No threads here. Hover a line and click <strong>+</strong> to leave a
        comment.
      </div>
    );
  }
  return (
    <div className="thread-list">
      <h2>Threads</h2>
      {threads.map((t) => (
        <div className={`thread-card status-${t.status}`} key={t.id}>
          <div className="thread-card-head">
            {showRepo && (
              <span className="repo-chip">
                {t.repo}
                {t.worktree ? ` · ${t.worktree}` : ""}
              </span>
            )}
            <span className="loc">
              {t.file ? `${t.file}:${t.line ?? "?"}` : "general"}
            </span>
          </div>
          <ThreadConversation thread={t} editors={editors} onChanged={onChanged} />
        </div>
      ))}
    </div>
  );
}
