import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { highlightLine, langForPath } from "../highlight.js";
import { useLineSelection } from "../useLineSelection.js";
import { CommentForm } from "./CommentForm.js";
import { Modal } from "./Modal.js";

/** Matches the daemon's per-read line cap (fileRoute clamps to from-1+2000). */
const MAX_LINES = 2000;

interface Props {
  repo: string;
  worktree: string | null;
  onClose: () => void;
  onCreated: () => void;
}

/** Pick any tracked file (not just changed ones) and comment on a line/range. */
export function CrossFileDialog({ repo, worktree, onClose, onCreated }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    api
      .repoFiles(repo, worktree)
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, [repo, worktree]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? files.filter((f) => f.toLowerCase().includes(q)) : files).slice(0, 200);
  }, [files, query]);

  return (
    <Modal title="Comment on another file" onClose={onClose}>
      {picked === null ? (
        <div className="cf-picker">
          <input
            className="aw-input"
            placeholder="Filter files…"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="cf-files">
            {filtered.length === 0 && <li className="muted">No files</li>}
            {filtered.map((f) => (
              <li key={f}>
                <button type="button" className="cf-file" onClick={() => setPicked(f)}>
                  <Icon name="file" size={14} />
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <CrossFileViewer
          repo={repo}
          worktree={worktree}
          file={picked}
          onBack={() => setPicked(null)}
          onCreated={() => {
            onCreated();
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

function CrossFileViewer({
  repo,
  worktree,
  file,
  onBack,
  onCreated,
}: {
  repo: string;
  worktree: string | null;
  file: string;
  onBack: () => void;
  onCreated: () => void;
}) {
  const lang = langForPath(file);
  const [lines, setLines] = useState<string[] | null>(null);
  // A full-file preview has only new-side lines, so selection is always "new".
  const { range, form, gutterProps, openComment, closeForm } = useLineSelection(
    () => lines?.length ?? 1,
  );

  useEffect(() => {
    // The server caps a file read at MAX_LINES; request exactly that so a
    // "first N lines" hint is accurate rather than guessing a larger number.
    api
      .file(repo, { path: file, side: "new", from: 1, to: MAX_LINES, worktree })
      .then((r) => setLines(r.lines))
      .catch(() => setLines([]));
  }, [repo, worktree, file]);

  return (
    <div className="cf-viewer">
      <div className="cf-viewer-head">
        <button type="button" className="ghost aw-up" onClick={onBack}>
          <Icon name="chevron-left" size={12} /> Files
        </button>
        <span className="cf-path" title={file}>
          {file}
        </span>
      </div>
      {lines !== null && lines.length === 0 && (
        <div className="muted">No previewable text content.</div>
      )}
      {lines !== null && lines.length >= MAX_LINES && (
        <div className="muted">Showing the first {MAX_LINES} lines.</div>
      )}
      {lines === null ? (
        <div className="loading">Loading…</div>
      ) : (
        <table className="hunk cf-lines">
          <tbody>
            {lines.map((text, i) => {
              const lineNo = i + 1;
              const selected =
                range !== null && lineNo >= range.lo && lineNo <= range.hi;
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
                  {form && lineNo === form.end && (
                    <tr>
                      <td className="ln" />
                      <td className="code">
                        <CommentForm
                          repo={repo}
                          worktree={worktree}
                          file={file}
                          side={form.side}
                          line={form.start}
                          endLine={form.end}
                          onCancel={closeForm}
                          onCreated={onCreated}
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
