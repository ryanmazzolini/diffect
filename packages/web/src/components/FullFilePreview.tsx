import { Fragment, useEffect, useMemo, useState } from "react";
import type { Thread } from "@diffect/shared";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { highlightLine, langForPath } from "../highlight.js";
import { useLineSelection } from "../useLineSelection.js";
import { CommentForm } from "./CommentForm.js";
import { ThreadConversation } from "./ThreadConversation.js";

/** Matches the daemon's per-read line cap (fileRoute clamps to from-1+2000). */
const MAX_LINES = 2000;

interface Props {
  repo: string;
  worktree: string | null;
  /** Review target spec a comment here is filed under (resolved to a scope by
   * the daemon). Threads on out-of-diff files still bind to the current review. */
  target: string;
  file: string;
  threads: Thread[];
  onBackToDiff: () => void;
  onChanged: () => void;
}

/** Full-file preview for commenting on tracked files that are not in the diff. */
export function FullFilePreview({
  repo,
  worktree,
  target,
  file,
  threads,
  onBackToDiff,
  onChanged,
}: Props) {
  const lang = langForPath(file);
  const [lines, setLines] = useState<string[] | null>(null);
  const { range, form, gutterProps, openComment, closeForm } = useLineSelection(
    () => lines?.length ?? 1,
  );
  const threadsByLine = useMemo(() => groupThreadsByLine(threads), [threads]);

  useEffect(() => {
    setLines(null);
    api
      .file(repo, { path: file, side: "new", from: 1, to: MAX_LINES, worktree })
      .then((r) => setLines(r.lines))
      .catch(() => setLines([]));
  }, [repo, worktree, file]);

  return (
    <div className="file full-file-preview" id={`file-${file}`}>
      <div className="file-header">
        <span className="status status-context">context</span>
        <span className="file-path" title={file}>{file}</span>
        <span className="out-of-diff-tag">not in this diff</span>
        <button type="button" className="ghost full-preview-back" onClick={onBackToDiff}>
          <Icon name="chevron-left" size={12} /> Diff
        </button>
      </div>

      {lines !== null && lines.length === 0 && (
        <div className="muted full-preview-note">No previewable text content.</div>
      )}
      {lines !== null && lines.length >= MAX_LINES && (
        <div className="muted full-preview-note">Showing the first {MAX_LINES} lines.</div>
      )}
      {lines === null ? (
        <div className="loading">Loading…</div>
      ) : (
        <table className="hunk full-file-lines">
          <tbody>
            {lines.map((text, i) => {
              const lineNo = i + 1;
              const selected =
                range !== null && lineNo >= range.lo && lineNo <= range.hi;
              const lineThreads = threadsByLine.get(lineNo) ?? [];
              return (
                <Fragment key={i}>
                  <tr className={`line line-context${selected ? " line-selected" : ""}`}>
                    <td
                      className="ln ln-clickable"
                      title="Click or drag to select; Enter to comment"
                      {...gutterProps("new", lineNo)}
                    >
                      {lineNo}
                    </td>
                    <td className="code">
                      <span className="text">{highlightLine(text, lang)}</span>
                      {!form && (
                        <button
                          className="comment-btn"
                          aria-label="Comment on this line or selection"
                          onClick={() => openComment("new", lineNo)}
                        >
                          <Icon name="plus" size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                  {lineThreads.map((thread) => (
                    <tr className="inline-thread-row" key={thread.id}>
                      <td className="ln" />
                      <td className="code">
                        <ThreadConversation thread={thread} onChanged={onChanged} />
                      </td>
                    </tr>
                  ))}
                  {form && lineNo === form.end && (
                    <tr>
                      <td className="ln" />
                      <td className="code">
                        <CommentForm
                          repo={repo}
                          worktree={worktree}
                          target={target}
                          file={file}
                          side={form.side}
                          line={form.start}
                          endLine={form.end}
                          onCancel={closeForm}
                          onCreated={() => {
                            closeForm();
                            onChanged();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function groupThreadsByLine(threads: Thread[]): Map<number, Thread[]> {
  const out = new Map<number, Thread[]>();
  for (const t of threads) {
    if (t.line === null) continue;
    const arr = out.get(t.line);
    if (arr) arr.push(t);
    else out.set(t.line, [t]);
  }
  return out;
}
