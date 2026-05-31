import { useState } from "react";
import type { DiffFile, DiffLine, RepoDiff, Thread } from "@diffect/shared";
import { CommentForm } from "./CommentForm.js";
import { ThreadConversation } from "./ThreadConversation.js";

interface Props {
  repo: string;
  worktree: string | null;
  diff: RepoDiff | null;
  threads: Thread[];
  onChanged: () => void;
}

export function DiffView({ repo, worktree, diff, threads, onChanged }: Props) {
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
  onChanged,
}: {
  repo: string;
  worktree: string | null;
  file: DiffFile;
  threads: Thread[];
  onChanged: () => void;
}) {
  // Which new-side line currently has its comment form open.
  const [commenting, setCommenting] = useState<number | null>(null);

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
                  threads={lineThreads}
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

function LineRow({
  line,
  threads,
  onChanged,
  isCommenting,
  onComment,
  commentForm,
}: {
  line: DiffLine;
  threads: Thread[];
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
          <span className="text">{line.text || " "}</span>
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
        <tr className="inline-thread-row" key={t.id}>
          <td className="ln" />
          <td className="ln" />
          <td className="code">
            <ThreadConversation thread={t} onChanged={onChanged} />
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
