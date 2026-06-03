import { useState } from "react";
import type { Thread } from "@diffect/shared";
import { api } from "../api.js";
import { useDraft } from "../useDraft.js";
import { Markdown } from "./Markdown.js";
import { MarkdownEditor } from "./MarkdownEditor.js";

/**
 * One thread's conversation plus its reply/resolve/dismiss controls. Shared by
 * the inline diff view and the thread inbox so both surfaces behave identically.
 */
export function ThreadConversation({
  thread,
  editors = [],
  onChanged,
}: {
  thread: Thread;
  editors?: string[];
  onChanged: () => void;
}) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply, clearReply] = useDraft(`draft-reply:${thread.id}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (op: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await op();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitReply = async () => {
    if (!reply.trim()) return;
    await run(() => api.reply(thread.id, { body: reply.trim() }));
    clearReply();
    setReplying(false);
  };

  return (
    <div className={`inline-thread status-${thread.status}`}>
      <div className="thread-meta">
        {thread.severity && (
          <span className={`sev sev-${thread.severity}`}>{thread.severity}</span>
        )}
        <span className={`status-badge status-${thread.status}`}>
          {thread.status}
        </span>
        {thread.anchorState === "stale" && (
          <span
            className="stale-badge"
            title="The commented code moved or was removed; this thread is outdated but kept for review."
          >
            outdated
          </span>
        )}
      </div>
      {thread.comments.map((c) => (
        <div className="comment" key={c.id}>
          <span className="author">
            {c.author.type === "agent" ? c.author.name ?? "agent" : "you"}
          </span>
          <div className="body">
            <Markdown>{c.body}</Markdown>
          </div>
        </div>
      ))}

      {replying ? (
        <div className="reply-form">
          <MarkdownEditor
            autoFocus
            value={reply}
            placeholder="Reply…"
            onChange={setReply}
            onSubmitKey={submitReply}
            onCancelKey={() => setReplying(false)}
          />
          <div className="thread-actions">
            <button className="ghost" onClick={() => setReplying(false)} disabled={busy}>
              Cancel
            </button>
            <button className="primary" onClick={submitReply} disabled={busy || !reply.trim()}>
              Reply
            </button>
          </div>
        </div>
      ) : (
        <div className="thread-actions">
          <button className="ghost" onClick={() => setReplying(true)} disabled={busy}>
            Reply
          </button>
          {thread.status === "open" && (
            <button
              className="ghost"
              disabled={busy}
              onClick={() => run(() => api.resolve(thread.id))}
            >
              Close
            </button>
          )}
          {thread.status !== "open" && (
            <button
              className="ghost danger"
              disabled={busy}
              title="Delete this thread permanently"
              onClick={() => {
                if (
                  window.confirm(
                    "Delete this thread permanently? This cannot be undone.",
                  )
                ) {
                  run(() => api.delete(thread.id));
                }
              }}
            >
              Delete
            </button>
          )}
          {editors.length > 0 && thread.file && thread.line !== null && (
            <button
              className="ghost"
              disabled={busy}
              title={`Open ${thread.file}:${thread.line} in ${editors[0]}`}
              onClick={() =>
                run(() =>
                  api.open({
                    repo: thread.repo,
                    worktree: thread.worktree,
                    file: thread.file!,
                    line: thread.line!,
                    editor: editors[0]!,
                  }),
                )
              }
            >
              Open
            </button>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
