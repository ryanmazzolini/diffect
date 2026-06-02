import { useState } from "react";
import type { DiffFile, DiffHunk, DiffLine, RepoDiff, Thread } from "@diffect/shared";
import { api } from "../api.js";
import { highlightLine, langForPath } from "../highlight.js";
import { CommentForm } from "./CommentForm.js";
import { ThreadConversation } from "./ThreadConversation.js";

interface Props {
  repo: string;
  worktree: string | null;
  diff: RepoDiff | null;
  threads: Thread[];
  editors: string[];
  onChanged: () => void;
}

export function DiffView({ repo, worktree, diff, threads, editors, onChanged }: Props) {
  if (!diff) return <div className="loading">Loading diff…</div>;
  if (diff.files.length === 0) {
    return <div className="empty">No changes in this target.</div>;
  }
  return (
    <div className="diff">
      {diff.files.map((file) => (
        <FileDiff
          key={file.path}
          repo={repo}
          worktree={worktree}
          file={file}
          threads={threads.filter((t) => t.file === file.path)}
          editors={editors}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function FileDiff({
  repo,
  worktree,
  file,
  threads,
  editors,
  onChanged,
}: {
  repo: string;
  worktree: string | null;
  file: DiffFile;
  threads: Thread[];
  editors: string[];
  onChanged: () => void;
}) {
  const lang = langForPath(file.path); // resolved once per file
  // In-progress gutter selection (new-side line numbers); the comment form opens
  // for the whole selected range.
  const [sel, setSel] = useState<{ anchor: number; head: number } | null>(null);
  const [form, setForm] = useState<{ start: number; end: number } | null>(null);

  const selRange = sel
    ? { lo: Math.min(sel.anchor, sel.head), hi: Math.max(sel.anchor, sel.head) }
    : null;

  // Click a line number to start a selection; shift-click to extend a range.
  const onGutter = (lineNo: number, shift: boolean) => {
    setForm(null);
    setSel((prev) =>
      shift && prev
        ? { anchor: prev.anchor, head: lineNo }
        : { anchor: lineNo, head: lineNo },
    );
  };

  // Open the comment form for the active selection if this line is in it, else
  // just this line.
  const openComment = (lineNo: number) => {
    const range =
      selRange && lineNo >= selRange.lo && lineNo <= selRange.hi
        ? { start: selRange.lo, end: selRange.hi }
        : { start: lineNo, end: lineNo };
    setForm(range);
    // Keep the highlight in sync with what the form will comment on, so opening
    // a single-line form outside an old selection doesn't leave a stale range lit.
    setSel({ anchor: range.start, head: range.end });
  };

  const closeForm = () => {
    setForm(null);
    setSel(null);
  };

  // Context lines unfolded above a hunk (new-side), keyed by hunk index.
  const [expanded, setExpanded] = useState<Record<number, DiffLine[]>>({});
  const unfold = async (hi: number, from: number, to: number) => {
    try {
      const r = await api.file(repo, {
        path: file.path,
        side: "new",
        from,
        to,
        worktree,
      });
      setExpanded((prev) => ({
        ...prev,
        [hi]: r.lines.map((text, i) => ({
          type: "context" as const,
          old: null,
          new: r.from + i,
          text,
        })),
      }));
    } catch {
      /* leave the gap collapsed on failure */
    }
  };

  return (
    <div className="file">
      <div className="file-header">
        <span className={`status status-${file.status}`}>{file.status}</span>
        <span className="file-path">{file.path}</span>
      </div>
      {file.hunks.map((hunk, hi) => {
        const gap = gapAbove(file.hunks, hi);
        const exp = expanded[hi];
        return (
        <table className="hunk" key={hi}>
          <tbody>
            {gap && !exp && (
              <tr className="unfold-row">
                <td className="ln" />
                <td className="ln" />
                <td className="code">
                  <button
                    type="button"
                    className="unfold-btn"
                    onClick={() => unfold(hi, gap.from, gap.to)}
                  >
                    ⋯ expand {gap.to - gap.from + 1} lines
                  </button>
                </td>
              </tr>
            )}
            {exp?.map((line, li) => (
              <tr className="line line-context" key={`x${li}`}>
                <td className="ln" />
                <td className="ln">{line.new}</td>
                <td className="code">
                  <span className="sigil"> </span>
                  <span className="text">{highlightLine(line.text, lang)}</span>
                </td>
              </tr>
            ))}
            <tr className="hunk-header">
              <td className="ln" />
              <td className="ln" />
              <td className="code">{hunk.header}</td>
            </tr>
            {hunk.lines.map((line, li) => {
              const lineThreads = line.new
                ? threads.filter((t) => t.side === "new" && t.line === line.new)
                : [];
              const selected =
                line.new !== null &&
                selRange !== null &&
                line.new >= selRange.lo &&
                line.new <= selRange.hi;
              return (
                <LineRow
                  key={li}
                  line={line}
                  lang={lang}
                  threads={lineThreads}
                  editors={editors}
                  onChanged={onChanged}
                  selected={selected}
                  onGutter={onGutter}
                  onComment={() => line.new && openComment(line.new)}
                  commentForm={
                    form !== null && line.new === form.end ? (
                      <CommentForm
                        repo={repo}
                        worktree={worktree}
                        file={file.path}
                        side="new"
                        line={form.start}
                        endLine={form.end}
                        onCancel={closeForm}
                        onCreated={() => {
                          closeForm();
                          onChanged();
                        }}
                      />
                    ) : null
                  }
                />
              );
            })}
          </tbody>
        </table>
        );
      })}
    </div>
  );
}

/** The collapsed new-side line span above hunk `hi`, or null if none. */
function gapAbove(
  hunks: DiffHunk[],
  hi: number,
): { from: number; to: number } | null {
  const prev = hunks[hi - 1];
  const prevEnd = prev ? prev.newStart + prev.newLines - 1 : 0;
  const from = prevEnd + 1;
  const to = hunks[hi]!.newStart - 1;
  return to >= from ? { from, to } : null;
}

/**
 * An inline thread in the diff. Open threads render in full; resolved/dismissed
 * ones collapse to a one-line marker that expands on click, keeping the diff
 * uncluttered while never hiding feedback outright.
 */
function InlineThread({
  thread,
  editors,
  onChanged,
}: {
  thread: Thread;
  editors: string[];
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(thread.status === "open");
  if (!expanded) {
    const first = thread.comments[0]?.body.split("\n")[0] ?? "";
    return (
      <button
        type="button"
        className={`thread-collapsed status-${thread.status}`}
        onClick={() => setExpanded(true)}
        title="Show thread"
      >
        <span className={`status-badge status-${thread.status}`}>
          {thread.status}
        </span>
        <span className="thread-collapsed-preview">{first}</span>
      </button>
    );
  }
  return (
    <ThreadConversation thread={thread} editors={editors} onChanged={onChanged} />
  );
}

function LineRow({
  line,
  lang,
  threads,
  editors,
  onChanged,
  selected,
  onGutter,
  onComment,
  commentForm,
}: {
  line: DiffLine;
  lang: string | null;
  threads: Thread[];
  editors: string[];
  onChanged: () => void;
  selected: boolean;
  onGutter: (lineNo: number, shift: boolean) => void;
  onComment: () => void;
  commentForm: React.ReactNode;
}) {
  const canComment = line.new !== null;
  return (
    <>
      <tr className={`line line-${line.type}${selected ? " line-selected" : ""}`}>
        <td className="ln">{line.old ?? ""}</td>
        <td
          className={`ln${canComment ? " ln-clickable" : ""}`}
          onClick={
            canComment ? (e) => onGutter(line.new!, e.shiftKey) : undefined
          }
          title={
            canComment ? "Click to select; shift-click to extend a range" : undefined
          }
        >
          {line.new ?? ""}
        </td>
        <td className="code">
          <span className="sigil">
            {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
          </span>
          <span className="text">{highlightLine(line.text, lang)}</span>
          {canComment && !commentForm && (
            <button
              className="comment-btn"
              title="Comment on this line or selection"
              onClick={onComment}
            >
              +
            </button>
          )}
        </td>
      </tr>
      {threads.map((t) => (
        // Re-key on status so a thread collapses the moment it's resolved/dismissed.
        <tr className="inline-thread-row" key={`${t.id}:${t.status}`}>
          <td className="ln" />
          <td className="ln" />
          <td className="code">
            <InlineThread thread={t} editors={editors} onChanged={onChanged} />
          </td>
        </tr>
      ))}
      {commentForm && (
        <tr className="comment-form-row">
          <td className="ln" />
          <td className="ln" />
          <td className="code">{commentForm}</td>
        </tr>
      )}
    </>
  );
}
