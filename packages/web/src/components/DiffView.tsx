import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  DiffViewWithMultiSelect,
  DiffFile as LibDiffFile,
  DiffModeEnum,
  SplitSide,
} from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import type { DiffFile, DiffHunk, RepoDiff, Side, Thread } from "@diffect/shared";
import type { Theme } from "../theme.js";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { highlightLine, langForPath } from "../highlight.js";
import { CommentForm } from "./CommentForm.js";
import { CrossFileDialog } from "./CrossFileDialog.js";
import { DiffStat } from "./DiffStat.js";
import { ThreadConversation } from "./ThreadConversation.js";

// Stable empty array so memoized children don't see a fresh [] each render.
const EMPTY_THREADS: Thread[] = [];

interface Props {
  repo: string;
  worktree: string | null;
  diff: RepoDiff | null;
  /** Files in display (tree) order — matches the sidebar so scrolling tracks it. */
  files: DiffFile[];
  threads: Thread[];
  editors: string[];
  viewed: Set<string>;
  /** Side-by-side rendering when true, inline (unified) when false. */
  split: boolean;
  onToggleSplit: () => void;
  /** Wrap long lines when true; scroll horizontally when false. */
  wrap: boolean;
  onToggleWrap: () => void;
  theme: Theme;
  onToggleViewed: (path: string) => void;
  onChanged: () => void;
}

// Memoized: re-renders only when the diff/threads/viewed-set actually change —
// not on scroll-spy active-file updates, pane resizes, or filter changes.
export const DiffView = memo(function DiffView({
  repo,
  worktree,
  diff,
  files,
  threads,
  editors,
  viewed,
  split,
  onToggleSplit,
  wrap,
  onToggleWrap,
  theme,
  onToggleViewed,
  onChanged,
}: Props) {
  const [crossFileOpen, setCrossFileOpen] = useState(false);
  // One pass to bucket threads by file, kept stable across renders so each file
  // gets a referentially-stable array (memo can then skip unchanged files).
  const threadsByFile = useMemo(() => groupThreadsByFile(threads), [threads]);
  const dialog = crossFileOpen ? (
    <CrossFileDialog
      repo={repo}
      worktree={worktree}
      onClose={() => setCrossFileOpen(false)}
      onCreated={onChanged}
    />
  ) : null;

  if (!diff) {
    return (
      <>
        {dialog}
        <div className="loading">Loading diff…</div>
      </>
    );
  }

  // Include rename old-paths so a thread on the pre-rename path of a file that's
  // in the diff isn't mistaken for an out-of-diff comment.
  const inDiff = new Set(
    files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])),
  );
  // Threads anchored to files outside the current diff render as collapsed
  // out-of-diff blocks so cross-file comments stay visible in the main view.
  const outOfDiff = [...threadsByFile.entries()]
    .filter(([file]) => !inDiff.has(file))
    .map(
      ([file, ts]) =>
        [file, ts.filter((t) => t.line !== null)] as [string, Thread[]],
    )
    .filter(([, ts]) => ts.length > 0);
  const totalAdd = files.reduce((n, f) => n + f.additions, 0);
  const totalDel = files.reduce((n, f) => n + f.deletions, 0);
  const mode = split ? DiffModeEnum.Split : DiffModeEnum.Unified;

  return (
    <div className="diff">
      {dialog}
      <div className="diff-summary">
        <span className="diff-summary-files">
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <DiffStat additions={totalAdd} deletions={totalDel} />
        <button
          type="button"
          className="ghost cf-open"
          onClick={() => setCrossFileOpen(true)}
        >
          <Icon name="plus" size={12} /> Comment on another file
        </button>
        <button
          type="button"
          className="ghost view-toggle"
          aria-pressed={split}
          title={split ? "Switch to unified view" : "Switch to split (side-by-side) view"}
          onClick={onToggleSplit}
        >
          {split ? "Unified" : "Split"}
        </button>
        <button
          type="button"
          className="ghost wrap-toggle"
          aria-pressed={!wrap}
          title={wrap ? "Stop wrapping long lines (scroll horizontally)" : "Wrap long lines"}
          onClick={onToggleWrap}
        >
          {wrap ? "No wrap" : "Wrap"}
        </button>
      </div>
      {files.length === 0 ? (
        <div className="empty">
          No changes in this target. Try a different compare target above, or
          comment on another file.
        </div>
      ) : (
        files.map((file) => (
          <FileDiff
            key={file.path}
            repo={repo}
            worktree={worktree}
            file={file}
            threads={threadsByFile.get(file.path) ?? EMPTY_THREADS}
            editors={editors}
            viewed={viewed.has(file.path)}
            mode={mode}
            wrap={wrap}
            theme={theme}
            onToggleViewed={onToggleViewed}
            onChanged={onChanged}
          />
        ))
      )}
      {outOfDiff.map(([file, fileThreads]) => (
        <OutOfDiffFile
          key={file}
          repo={repo}
          worktree={worktree}
          file={file}
          threads={fileThreads}
          editors={editors}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
});

const sigil = (type: DiffHunk["lines"][number]["type"]) =>
  type === "add" ? "+" : type === "del" ? "-" : " ";

/** Re-serialize our parsed file back into a full unified-diff string (with
 *  `diff --git`/`---`/`+++` headers) — the form git-diff-view's parser expects. */
function toFullDiff(file: DiffFile): string {
  const oldPath = file.oldPath ?? file.path;
  const isAdd = file.status === "added" || file.status === "untracked";
  const isDel = file.status === "deleted";
  const out: string[] = [
    `diff --git a/${oldPath} b/${file.path}`,
    `--- ${isAdd ? "/dev/null" : `a/${oldPath}`}`,
    `+++ ${isDel ? "/dev/null" : `b/${file.path}`}`,
  ];
  for (const hunk of file.hunks) {
    out.push(hunk.header);
    for (const l of hunk.lines) out.push(sigil(l.type) + l.text);
  }
  return out.join("\n");
}

/** Thread bucket keyed by line number, split by side — git-diff-view's extendData shape. */
function buildExtendData(threads: Thread[]): {
  oldFile: Record<string, { data: Thread[] }>;
  newFile: Record<string, { data: Thread[] }>;
} {
  const oldFile: Record<string, { data: Thread[] }> = {};
  const newFile: Record<string, { data: Thread[] }> = {};
  for (const t of threads) {
    if (t.line === null || t.side === null) continue;
    const bucket = t.side === "old" ? oldFile : newFile;
    (bucket[String(t.line)] ??= { data: [] }).data.push(t);
  }
  return { oldFile, newFile };
}

const toSide = (side: SplitSide): Side => (side === SplitSide.old ? "old" : "new");

// Memoized so a thread change on one file doesn't re-render every other file.
const FileDiff = memo(function FileDiff({
  repo,
  worktree,
  file,
  threads,
  editors,
  viewed,
  mode,
  wrap,
  theme,
  onToggleViewed,
  onChanged,
}: {
  repo: string;
  worktree: string | null;
  file: DiffFile;
  threads: Thread[];
  editors: string[];
  viewed: boolean;
  mode: DiffModeEnum;
  wrap: boolean;
  theme: Theme;
  onToggleViewed: (path: string) => void;
  onChanged: () => void;
}) {
  // Build + initialize the lib's DiffFile instance. git-diff-view parses a full
  // unified-diff string (with `diff --git`/`---`/`+++` headers) — we re-serialize
  // our parsed hunks back into that form. No file content needed for rendering;
  // context expansion (which would need it) is left for a follow-up.
  const diffFile = useMemo(() => {
    const f = LibDiffFile.createInstance({
      oldFile: {
        fileName: file.oldPath ?? file.path,
        fileLang: langForPath(file.oldPath ?? file.path) ?? undefined,
      },
      newFile: {
        fileName: file.path,
        fileLang: langForPath(file.path) ?? undefined,
      },
      hunks: [toFullDiff(file)],
    });
    f.init();
    f.buildSplitDiffLines();
    f.buildUnifiedDiffLines();
    return f;
  }, [file]);
  const extendData = useMemo(() => buildExtendData(threads), [threads]);

  // Existing threads, rendered persistently under their anchor line.
  const renderExtendLine = useCallback(
    ({ data, onUpdate }: { data: Thread[]; onUpdate: () => void }) => (
      <div className="lib-thread-stack">
        {data.map((t) => (
          <InlineThread
            key={`${t.id}:${t.status}`}
            thread={t}
            editors={editors}
            onChanged={() => {
              onChanged();
              onUpdate();
            }}
          />
        ))}
      </div>
    ),
    [editors, onChanged],
  );

  // The new-comment form, opened by the + button or a drag range selection.
  const renderWidgetLine = useCallback(
    ({
      side,
      lineNumber,
      fromLineNumber,
      onClose,
    }: {
      side: SplitSide;
      lineNumber: number;
      fromLineNumber: number;
      onClose: () => void;
    }) => {
      const start = Math.min(lineNumber, fromLineNumber);
      const end = Math.max(lineNumber, fromLineNumber);
      return (
        <div className="lib-widget">
          <CommentForm
            repo={repo}
            worktree={worktree}
            file={file.path}
            side={toSide(side)}
            line={start}
            endLine={end}
            onCancel={onClose}
            onCreated={() => {
              onClose();
              onChanged();
            }}
          />
        </div>
      );
    },
    [repo, worktree, file.path, onChanged],
  );

  return (
    <div className={`file${viewed ? " viewed" : ""}`} id={`file-${file.path}`}>
      <div className="file-header">
        <span className={`status status-${file.status}`}>{file.status}</span>
        <span className="file-path">{file.path}</span>
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <label className="viewed-toggle" title="Mark this file viewed (collapses it)">
          <input
            type="checkbox"
            aria-label="Viewed"
            checked={viewed}
            onChange={() => onToggleViewed(file.path)}
          />
          Viewed
        </label>
      </div>
      {!viewed && (
        <DiffViewWithMultiSelect<Thread[]>
          diffFile={diffFile}
          extendData={extendData}
          diffViewMode={mode}
          diffViewWrap={wrap}
          diffViewTheme={theme}
          diffViewHighlight
          diffViewAddWidget
          enableMultiSelect
          renderExtendLine={renderExtendLine}
          renderWidgetLine={renderWidgetLine}
        />
      )}
    </div>
  );
});

/** Bucket threads by file path (insertion order preserved); skips general threads. */
function groupThreadsByFile(threads: Thread[]): Map<string, Thread[]> {
  const byFile = new Map<string, Thread[]>();
  for (const t of threads) {
    if (t.file === null) continue;
    const arr = byFile.get(t.file);
    if (arr) arr.push(t);
    else byFile.set(t.file, [t]);
  }
  return byFile;
}

/** A synthetic file block for threads whose file isn't in the diff. */
function OutOfDiffFile({
  repo,
  worktree,
  file,
  threads,
  editors,
  onChanged,
}: {
  repo: string;
  worktree: string | null;
  file: string;
  threads: Thread[];
  editors: string[];
  onChanged: () => void;
}) {
  return (
    <div className="file out-of-diff" id={`file-${file}`}>
      <div className="file-header">
        <span className="status status-context">context</span>
        <span className="file-path">{file}</span>
        <span className="out-of-diff-tag">not in this diff</span>
      </div>
      {threads.map((t) => (
        <OutOfDiffThread
          key={t.id}
          repo={repo}
          worktree={worktree}
          file={file}
          thread={t}
          editors={editors}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

/** Fetches a few lines of context around an out-of-diff thread and renders it. */
function OutOfDiffThread({
  repo,
  worktree,
  file,
  thread,
  editors,
  onChanged,
}: {
  repo: string;
  worktree: string | null;
  file: string;
  thread: Thread;
  editors: string[];
  onChanged: () => void;
}) {
  const lang = langForPath(file);
  const line = thread.line!;
  const [ctx, setCtx] = useState<{ from: number; lines: string[] } | null>(null);
  useEffect(() => {
    api
      .file(repo, { path: file, side: "new", from: Math.max(1, line - 2), to: line + 2, worktree })
      .then((r) => setCtx({ from: r.from, lines: r.lines }))
      .catch(() => setCtx(null));
  }, [repo, worktree, file, line]);

  return (
    <table className="hunk">
      <tbody>
        {ctx?.lines.map((text, i) => (
          <tr className="line line-context" key={i}>
            <td className="ln">{ctx.from + i}</td>
            <td className="code">
              <span className="text">{highlightLine(text, lang)}</span>
            </td>
          </tr>
        ))}
        <tr className="inline-thread-row">
          <td className="ln" />
          <td className="code">
            <InlineThread thread={thread} editors={editors} onChanged={onChanged} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * An inline thread in the diff. Open threads render in full; closed ones collapse
 * to a one-line marker that expands on click, keeping the diff uncluttered while
 * never hiding feedback outright.
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
