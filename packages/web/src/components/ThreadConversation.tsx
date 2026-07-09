import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Thread } from "@diffect/shared";
import { api } from "../api.js";
import { useCurrentSnapshot } from "../currentSnapshot.js";
import { relativeTime } from "../relativeTime.js";
import { getStored, removeStored, setStored } from "../storage.js";
import { useDraft } from "../useDraft.js";
import { Markdown } from "./Markdown.js";
import { MarkdownEditor } from "./MarkdownEditor.js";

/**
 * One thread's conversation plus its reply/resolve/dismiss controls, rendered as
 * a dense full-width strip (avatar + author inline, body using the width below).
 * Shared by the inline diff view and the thread pane so both behave identically.
 */
export function ThreadConversation({
  thread,
  onChanged,
  onNavigate,
}: {
  thread: Thread;
  onChanged: () => void;
  onNavigate?: () => void;
}) {
  const replyOpenKey = `draft-reply-open:${thread.id}`;
  const [reply, setReply, clearReply] = useDraft(`draft-reply:${thread.id}`);
  const [replying, setReplyingState] = useState(
    () => reply.trim().length > 0 || getStored(replyOpenKey) === "1",
  );
  const setReplying = (open: boolean) => {
    if (open) setStored(replyOpenKey, "1");
    else removeStored(replyOpenKey);
    setReplyingState(open);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bodyOpen, setBodyOpen] = useState(true);

  // Filed in an earlier iteration of this review: the thread's snapshot predates
  // the diff on screen. Purely informational — distinct from `anchorState`
  // "outdated" (the code moved/vanished). When either id is missing we can't make
  // the claim, so we stay silent.
  const currentSnapshotId = useCurrentSnapshot();
  const earlierIteration =
    !!thread.snapshotId &&
    !!currentSnapshotId &&
    thread.snapshotId !== currentSnapshotId;

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

  const count = thread.comments.length;

  return (
    <div className={`inline-thread status-${thread.status}`} data-thread-id={thread.id}>
      <div className="thread-head">
        {thread.severity && (
          <span className={`sev sev-${thread.severity}`}>{thread.severity}</span>
        )}
        {thread.anchorState === "stale" && (
          <span
            className="stale-badge"
            title="The commented code moved or was removed; this thread is outdated but kept for review."
          >
            outdated
          </span>
        )}
        {earlierIteration && (
          <span
            className="iteration-badge"
            title="Filed in an earlier iteration of this review. Still tracked and current — shown for context only."
          >
            earlier iteration
          </span>
        )}
        <span className="thread-state">
          {count} comment{count === 1 ? "" : "s"} · {thread.status}
        </span>
        <div className="thread-head-actions">
          <button
            type="button"
            className="thread-collapse-toggle"
            aria-expanded={bodyOpen}
            onClick={() => setBodyOpen((o) => !o)}
          >
            {bodyOpen ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>

      <div className={`thread-body-wrap${bodyOpen ? "" : " collapsed"}`}>
        <div className="thread-body-inner">
          {thread.comments.map((c) => {
            const author = authorView(c.author);
            return (
              <div
                className={`t-comment${onNavigate ? " jumpable" : ""}`}
                key={c.id}
                role={onNavigate ? "button" : undefined}
                tabIndex={onNavigate ? 0 : undefined}
                title={onNavigate ? "Show this comment in the diff" : undefined}
                onClick={(event) => maybeNavigate(event, onNavigate)}
                onKeyDown={(event) => maybeNavigateWithKeyboard(event, onNavigate)}
              >
                <div className="c-meta">
                  <span className={`avatar avatar-${author.kind}`} aria-hidden="true">
                    {author.initials}
                  </span>
                  <span className="c-name">{author.name}</span>
                  {author.role && <span className="c-role">{author.role}</span>}
                  <span className="c-when" title={c.ts}>
                    {relativeTime(c.ts)}
                  </span>
                </div>
                <div className="c-text">
                  <Markdown>{c.body}</Markdown>
                </div>
              </div>
            );
          })}

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
                <button
                  className="primary"
                  onClick={submitReply}
                  disabled={busy || !reply.trim()}
                >
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
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function maybeNavigate(event: MouseEvent<HTMLDivElement>, onNavigate?: () => void): void {
  if (!onNavigate) return;
  if (isInteractive(event.target)) return;
  if (window.getSelection()?.toString()) return;
  onNavigate();
}

function maybeNavigateWithKeyboard(
  event: KeyboardEvent<HTMLDivElement>,
  onNavigate?: () => void,
): void {
  if (!onNavigate) return;
  if (event.currentTarget !== event.target) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onNavigate();
}

function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest("a, button, input, textarea, select, [contenteditable='true']")
  );
}

/** Display name, role, avatar kind and initials for a comment author. */
function authorView(author: { type: string; name?: string | null }): {
  name: string;
  role: string | null;
  kind: "you" | "agent";
  initials: string;
} {
  if (author.type === "agent") {
    const name = author.name ?? "agent";
    const initials = name.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "ai";
    return { name, role: "agent", kind: "agent", initials };
  }
  return { name: "you", role: null, kind: "you", initials: "Y" };
}
