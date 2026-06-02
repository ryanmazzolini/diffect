import { useState } from "react";
import type { DiffFile, DiffLine, RepoDiff, Thread } from "@diffect/shared";
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
  // Which new-side line currently has its comment form open.
  const [commenting, setCommenting] = useState<number | null>(null);
  const lang = langForPath(file.path); // resolved once per file

  return (
    <div className="file">
      <div className="file-header">
        <span className={`status status-${file.status}`}>{file.status}</span>
        <span className="file-path">{file.path}</span>
      </div>
      {file.hunks.map((hunk, hi) => (
        <table className="hunk" key={hi}>
          <tbody>
            <tr className="hunk-header">
              <td className="ln" />
              <td className="ln" />
              <td className="code">{hunk.header}</td>
            </tr>
            {hunk.lines.map((line, li) => {
              const lineThreads = line.new
                ? threads.filter((t) => t.side === "new" && t.line === line.new)
                : [];
              return (
                <LineRow
                  key={li}
                  line={line}
                  lang={lang}
                  threads={lineThreads}
                  editors={editors}
                  onChanged={onChanged}
                  isCommenting={commenting === line.new && line.new !== null}
                  onComment={() => line.new && setCommenting(line.new)}
                  commentForm={
                    commenting === line.new && line.new !== null ? (
                      <CommentForm
                        repo={repo}
                        worktree={worktree}
                        file={file.path}
                        side="new"
                        line={line.new}
                        onCancel={() => setCommenting(null)}
                        onCreated={() => {
                          setCommenting(null);
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
      ))}
    </div>
  );
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
  isCommenting,
  onComment,
  commentForm,
}: {
  line: DiffLine;
  lang: string | null;
  threads: Thread[];
  editors: string[];
  onChanged: () => void;
  isCommenting: boolean;
  onComment: () => void;
  commentForm: React.ReactNode;
}) {
  const canComment = line.new !== null;
  return (
    <>
      <tr className={`line line-${line.type}`}>
        <td className="ln">{line.old ?? ""}</td>
        <td className="ln">{line.new ?? ""}</td>
        <td className="code">
          <span className="sigil">
            {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
          </span>
          <span className="text">{highlightLine(line.text, lang)}</span>
          {canComment && !isCommenting && (
            <button
              className="comment-btn"
              title="Comment on this line"
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
      {isCommenting && (
        <tr className="comment-form-row">
          <td className="ln" />
          <td className="ln" />
          <td className="code">{commentForm}</td>
        </tr>
      )}
    </>
  );
}
