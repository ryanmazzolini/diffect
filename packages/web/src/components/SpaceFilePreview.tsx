import { Fragment, useEffect, useMemo, useState } from "react";
import type { Thread } from "@diffect/shared";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { highlightLine, langForPath } from "../highlight.js";
import { useLineSelection } from "../useLineSelection.js";
import { CommentForm } from "./CommentForm.js";
import { OpenInMenu } from "./OpenInMenu.js";
import { ThreadConversation } from "./ThreadConversation.js";

const MAX_LINES = 2000;

interface Props {
  workspacePath: string;
  file: string;
  threads: Thread[];
  onBackToDiff: () => void;
  onChanged: () => void;
  editors: string[];
  editor: string | null;
  onEditor: (editor: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}

export function SpaceFilePreview({
  workspacePath,
  file,
  threads,
  onBackToDiff,
  onChanged,
  editors,
  editor,
  onEditor,
  onOpenFile,
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
      .spaceFile(workspacePath, { path: file, from: 1, to: MAX_LINES })
      .then((r) => setLines(r.lines))
      .catch(() => setLines([]));
  }, [workspacePath, file]);

  return (
    <section className="diff-pane space-file-preview">
      <div className="file full-file-preview" id={`space-file-${file}`}>
        <div className="file-header">
          <span className="status status-context">space</span>
          <span className="file-path" title={file}>{file}</span>
          <span className="out-of-diff-tag">outside repos</span>
          <OpenInMenu
            className="file-open-in-menu"
            editors={editors}
            editor={editor}
            onEditor={onEditor}
            primaryAction={() => onOpenFile(file)}
          />
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
                const selected = range !== null && lineNo >= range.lo && lineNo <= range.hi;
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
                            repo={null}
                            spacePath={workspacePath}
                            worktree={null}
                            target="space"
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
    </section>
  );
}

function groupThreadsByLine(threads: Thread[]): Map<number, Thread[]> {
  const map = new Map<number, Thread[]>();
  for (const t of threads) {
    if (t.line === null) continue;
    const list = map.get(t.line);
    if (list) list.push(t);
    else map.set(t.line, [t]);
  }
  return map;
}
