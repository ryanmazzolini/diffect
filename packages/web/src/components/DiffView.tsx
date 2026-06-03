import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { DiffFile, DiffHunk, DiffLine, RepoDiff, Side, Thread } from "@diffect/shared";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { highlightLine, highlightLineWithDiff, langForPath } from "../highlight.js";
import { wordDiff, type Range as WordRange } from "../wordDiff.js";
import { useLineSelection, type LineSelection } from "../useLineSelection.js";
import { CommentForm } from "./CommentForm.js";
import { CrossFileDialog } from "./CrossFileDialog.js";
import { DiffStat } from "./DiffStat.js";
import { ThreadConversation } from "./ThreadConversation.js";

// Stable empty array so memoized rows for files/lines with no threads don't see a
// fresh [] each render.
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
  onToggleViewed,
  onChanged,
}: Props) {
  const [crossFileOpen, setCrossFileOpen] = useState(false);
  // One pass to bucket threads by file, kept stable across renders so each
  // FileDiff gets a referentially-stable array (memo can then skip unchanged files).
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
            split={split}
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

/**
 * Pair each replaced line (a run of deletions immediately followed by additions)
 * with its counterpart and compute a word-level diff, returning the changed
 * character ranges keyed by line. Only replacements get intra-line highlighting;
 * pure adds/removes don't (there's nothing to compare against).
 */
function computeWordDiffs(hunks: DiffHunk[]): Map<DiffLine, WordRange[]> {
  const map = new Map<DiffLine, WordRange[]>();
  for (const hunk of hunks) addHunkWordDiffs(hunk.lines, map);
  return map;
}

/** Index after the run of `type` lines starting at `start`. */
function runEnd(lines: DiffLine[], start: number, type: DiffLine["type"]): number {
  let k = start;
  while (k < lines.length && lines[k]!.type === type) k++;
  return k;
}

function addHunkWordDiffs(lines: DiffLine[], map: Map<DiffLine, WordRange[]>): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.type !== "del") {
      i++;
      continue;
    }
    const d = runEnd(lines, i, "del"); // end of the deletion run
    const a = runEnd(lines, d, "add"); // end of the following addition run
    pairLineWordDiffs(lines.slice(i, d), lines.slice(d, a), map);
    i = a > i ? a : i + 1;
  }
}

/** Pair removed line k with added line k and record each side's changed ranges. */
function pairLineWordDiffs(
  dels: DiffLine[],
  adds: DiffLine[],
  map: Map<DiffLine, WordRange[]>,
): void {
  const pairs = Math.min(dels.length, adds.length);
  for (let k = 0; k < pairs; k++) {
    const wd = wordDiff(dels[k]!.text, adds[k]!.text);
    if (wd.del.length) map.set(dels[k]!, wd.del);
    if (wd.add.length) map.set(adds[k]!, wd.add);
  }
}

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

// Memoized so a selection drag or a thread change on one file doesn't re-render
// every other file in a large diff.
const FileDiff = memo(function FileDiff({
  repo,
  worktree,
  file,
  threads,
  editors,
  viewed,
  split,
  onToggleViewed,
  onChanged,
}: {
  repo: string;
  worktree: string | null;
  file: DiffFile;
  threads: Thread[];
  editors: string[];
  viewed: boolean;
  split: boolean;
  onToggleViewed: (path: string) => void;
  onChanged: () => void;
}) {
  const lang = langForPath(file.path); // resolved once per file
  // Largest line number per side, to clamp keyboard range extension.
  const maxNew = file.hunks.reduce(
    (m, h) => Math.max(m, h.newStart + h.newLines - 1),
    0,
  );
  const maxOld = file.hunks.reduce(
    (m, h) => Math.max(m, h.oldStart + h.oldLines - 1),
    0,
  );
  const maxLineForSide = useCallback(
    (side: Side) => (side === "old" ? maxOld : maxNew),
    [maxOld, maxNew],
  );
  // `${side}:${line}` → its threads, stable across renders so each LineRow's
  // `threads` prop only changes when that line's threads do (keeps memo effective).
  const threadsByLine = useMemo(() => {
    const m = new Map<string, Thread[]>();
    for (const t of threads) {
      if (t.line !== null && t.side !== null) {
        const key = `${t.side}:${t.line}`;
        const arr = m.get(key);
        if (arr) arr.push(t);
        else m.set(key, [t]);
      }
    }
    return m;
  }, [threads]);
  // Word-level diff ranges per replaced line, memoized (stable refs) so the
  // selection drag doesn't recompute or break LineRow memoization.
  const wordRangesByLine = useMemo(() => computeWordDiffs(file.hunks), [file.hunks]);
  // Gutter selection (click / shift-click / drag / keyboard) over either side.
  const {
    range: selRange,
    form,
    gutterProps,
    rowProps,
    commentButtonProps,
    openComment,
    closeForm,
  } = useLineSelection(maxLineForSide);

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

  // Centralized so the unified and split renderers create the form identically.
  const renderForm = useCallback(
    (side: Side, start: number, end: number) => (
      <CommentForm
        repo={repo}
        worktree={worktree}
        file={file.path}
        side={side}
        line={start}
        endLine={end}
        onCancel={closeForm}
        onCreated={() => {
          closeForm();
          onChanged();
        }}
      />
    ),
    [repo, worktree, file.path, closeForm, onChanged],
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
      {!viewed &&
        file.hunks.map((hunk, hi) => {
          const rows: HunkRowsProps = {
            hunk,
            hi,
            gap: gapAbove(file.hunks, hi),
            exp: expanded[hi],
            unfold,
            lang,
            threadsByLine,
            wordRangesByLine,
            selRange,
            form,
            gutterProps,
            rowProps,
            commentButtonProps,
            openComment,
            editors,
            onChanged,
            renderForm,
          };
          return (
            <table className={`hunk${split ? " hunk-split" : ""}`} key={hi}>
              <tbody>
                {split ? <SplitHunkRows {...rows} /> : <UnifiedHunkRows {...rows} />}
              </tbody>
            </table>
          );
        })}
    </div>
  );
});

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

const GUTTER_TITLE = "Click, shift-click, or drag to select; Enter to comment";

/** One line-number gutter cell, wired for selection only when it's commentable. */
function GutterCell({
  value,
  side,
  active,
  gutterProps,
}: {
  value: number | null;
  side: Side;
  active: boolean;
  gutterProps: LineSelection["gutterProps"];
}) {
  return (
    <td
      className={`ln${active ? " ln-clickable" : ""}`}
      title={active ? GUTTER_TITLE : undefined}
      {...(active && value !== null ? gutterProps(side, value) : {})}
    >
      {value ?? ""}
    </td>
  );
}

// Memoized so a selection drag (which re-renders the parent file on each move)
// only re-renders the rows whose `selected`/form state actually changed.
const LineRow = memo(function LineRow({
  line,
  lang,
  threads,
  editors,
  onChanged,
  selected,
  commentSide,
  commentLine,
  wordRanges,
  gutterProps,
  rowProps,
  commentButtonProps,
  openComment,
  commentForm,
}: {
  line: DiffLine;
  lang: string | null;
  threads: Thread[];
  editors: string[];
  onChanged: () => void;
  selected: boolean;
  /** Side this row's comments anchor to ("old" for removed lines). */
  commentSide: Side;
  /** Line number on that side, or null when the row isn't commentable. */
  commentLine: number | null;
  /** Changed char ranges for intra-line (word) diff, or undefined. */
  wordRanges: WordRange[] | undefined;
  gutterProps: LineSelection["gutterProps"];
  rowProps: LineSelection["rowProps"];
  commentButtonProps: LineSelection["commentButtonProps"];
  openComment: (side: Side, lineNo: number) => void;
  commentForm: React.ReactNode;
}) {
  const canComment = commentLine !== null;
  const oldClickable = canComment && commentSide === "old";
  const newClickable = canComment && commentSide === "new";
  const onComment = () => canComment && openComment(commentSide, commentLine!);
  return (
    <>
      <tr
        className={`line line-${line.type}${selected ? " line-selected" : ""}`}
        {...(canComment ? rowProps(commentSide, commentLine!) : {})}
      >
        <GutterCell
          value={line.old}
          side="old"
          active={oldClickable}
          gutterProps={gutterProps}
        />
        <GutterCell
          value={line.new}
          side="new"
          active={newClickable}
          gutterProps={gutterProps}
        />
        <td className="code">
          <span className="sigil">
            {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
          </span>
          <span className="text">
            {wordRanges
              ? highlightLineWithDiff(line.text, lang, wordRanges, "diff-word")
              : highlightLine(line.text, lang)}
          </span>
          {canComment && !commentForm && (
            <button
              className="comment-btn"
              title="Click to comment, or drag to select a range"
              aria-label="Comment on this line or selection"
              onClick={onComment}
              {...commentButtonProps(commentSide, commentLine!)}
            >
              <Icon name="plus" size={12} />
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
});

// ── Shared hunk-row context, passed to both the unified and split renderers ──
interface HunkRowsProps {
  hunk: DiffHunk;
  hi: number;
  gap: { from: number; to: number } | null;
  exp: DiffLine[] | undefined;
  unfold: (hi: number, from: number, to: number) => void;
  lang: string | null;
  threadsByLine: Map<string, Thread[]>;
  wordRangesByLine: Map<DiffLine, WordRange[]>;
  selRange: LineSelection["range"];
  form: LineSelection["form"];
  gutterProps: LineSelection["gutterProps"];
  rowProps: LineSelection["rowProps"];
  commentButtonProps: LineSelection["commentButtonProps"];
  openComment: (side: Side, lineNo: number) => void;
  editors: string[];
  onChanged: () => void;
  renderForm: (side: Side, start: number, end: number) => React.ReactNode;
}

const sigilOf = (type: DiffLine["type"]) =>
  type === "add" ? "+" : type === "del" ? "-" : " ";

/** The "expand N lines" control above a hunk gap. */
function UnfoldButton({
  hi,
  gap,
  unfold,
}: {
  hi: number;
  gap: { from: number; to: number };
  unfold: (hi: number, from: number, to: number) => void;
}) {
  return (
    <button
      type="button"
      className="unfold-btn"
      onClick={() => unfold(hi, gap.from, gap.to)}
    >
      <Icon name="fold-down" size={12} /> expand {gap.to - gap.from + 1} lines
    </button>
  );
}

/** Sigil + highlighted text for a code cell's contents. */
function CodeText({ text, lang }: { text: string; lang: string | null }) {
  return (
    <>
      <span className="sigil"> </span>
      <span className="text">{highlightLine(text, lang)}</span>
    </>
  );
}

/** Unified (inline) hunk body: the original 3-column rows. */
function UnifiedHunkRows(p: HunkRowsProps) {
  return (
    <>
      {p.gap && !p.exp && (
        <tr className="unfold-row">
          <td className="ln" />
          <td className="ln" />
          <td className="code">
            <UnfoldButton hi={p.hi} gap={p.gap} unfold={p.unfold} />
          </td>
        </tr>
      )}
      {p.exp?.map((line, li) => (
        <tr className="line line-context" key={`x${li}`}>
          <td className="ln" />
          <td className="ln">{line.new}</td>
          <td className="code">
            <CodeText text={line.text} lang={p.lang} />
          </td>
        </tr>
      ))}
      <tr className="hunk-header">
        <td className="ln" />
        <td className="ln" />
        <td className="code">{p.hunk.header}</td>
      </tr>
      {p.hunk.lines.map((line, li) => {
        const commentSide: Side = line.type === "del" ? "old" : "new";
        const commentLine = commentSide === "old" ? line.old : line.new;
        const threads =
          commentLine !== null
            ? (p.threadsByLine.get(`${commentSide}:${commentLine}`) ?? EMPTY_THREADS)
            : EMPTY_THREADS;
        const selected =
          commentLine !== null &&
          p.selRange !== null &&
          p.selRange.side === commentSide &&
          commentLine >= p.selRange.lo &&
          commentLine <= p.selRange.hi;
        const showForm =
          p.form !== null && p.form.side === commentSide && commentLine === p.form.end;
        return (
          <LineRow
            key={li}
            line={line}
            lang={p.lang}
            threads={threads}
            editors={p.editors}
            onChanged={p.onChanged}
            selected={selected}
            commentSide={commentSide}
            commentLine={commentLine}
            wordRanges={p.wordRangesByLine.get(line)}
            gutterProps={p.gutterProps}
            rowProps={p.rowProps}
            commentButtonProps={p.commentButtonProps}
            openComment={p.openComment}
            commentForm={
              showForm ? p.renderForm(p.form!.side, p.form!.start, p.form!.end) : null
            }
          />
        );
      })}
    </>
  );
}

interface SplitRowData {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Aligned [old | new] rows: context on both sides, replacements zipped index by
 *  index, unpaired add/del filling one side with a blank. */
function alignRows(lines: DiffLine[]): SplitRowData[] {
  const rows: SplitRowData[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i++;
    } else if (line.type === "del") {
      const d = runEnd(lines, i, "del");
      const a = runEnd(lines, d, "add");
      const dels = lines.slice(i, d);
      const adds = lines.slice(d, a);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      i = a;
    } else {
      const a = runEnd(lines, i, "add"); // a lone addition run
      for (let k = i; k < a; k++) rows.push({ left: null, right: lines[k]! });
      i = a;
    }
  }
  return rows;
}

interface SideCtx {
  threadsByLine: Map<string, Thread[]>;
  wordRangesByLine: Map<DiffLine, WordRange[]>;
  selRange: LineSelection["range"];
  form: LineSelection["form"];
  renderForm: (side: Side, start: number, end: number) => React.ReactNode;
}
interface SideResolved {
  lineNo: number | null;
  commentable: boolean;
  ranges: WordRange[] | undefined;
  selected: boolean;
  threads: Thread[];
  form: React.ReactNode;
}

/** Resolve one side of a split row into the stable primitives SplitRow renders. */
function sideProps(line: DiffLine | null, side: Side, ctx: SideCtx): SideResolved {
  const lineNo = !line ? null : side === "old" ? line.old : line.new;
  const commentable = !!line && (side === "old" ? line.type === "del" : line.new !== null);
  const inSel =
    lineNo !== null &&
    ctx.selRange !== null &&
    ctx.selRange.side === side &&
    lineNo >= ctx.selRange.lo &&
    lineNo <= ctx.selRange.hi;
  return {
    lineNo,
    commentable,
    ranges: line ? ctx.wordRangesByLine.get(line) : undefined,
    selected: commentable && inSel,
    threads:
      commentable && lineNo !== null
        ? (ctx.threadsByLine.get(`${side}:${lineNo}`) ?? EMPTY_THREADS)
        : EMPTY_THREADS,
    form:
      commentable && ctx.form?.side === side && ctx.form.end === lineNo
        ? ctx.renderForm(side, ctx.form.start, ctx.form.end)
        : null,
  };
}

/** One side's gutter + code cells in split view (a blank pair when absent). */
function SplitSide({
  line,
  side,
  resolved,
  suppressBtn,
  lang,
  gutterProps,
  rowProps,
  commentButtonProps,
  openComment,
}: {
  line: DiffLine | null;
  side: Side;
  resolved: SideResolved;
  suppressBtn: boolean;
  lang: string | null;
  gutterProps: LineSelection["gutterProps"];
  rowProps: LineSelection["rowProps"];
  commentButtonProps: LineSelection["commentButtonProps"];
  openComment: (side: Side, lineNo: number) => void;
}) {
  if (!line) {
    return (
      <>
        <td className="ln ln-filler" />
        <td className="code code-filler" />
      </>
    );
  }
  const { lineNo, commentable, ranges, selected } = resolved;
  const active = commentable && lineNo !== null;
  return (
    <>
      <td
        className={`ln line-${line.type}${active ? " ln-clickable" : ""}`}
        title={active ? GUTTER_TITLE : undefined}
        {...(active ? gutterProps(side, lineNo) : {})}
      >
        {lineNo ?? ""}
      </td>
      <td
        className={`code line-${line.type}${selected ? " split-selected" : ""}`}
        {...(active ? rowProps(side, lineNo) : {})}
      >
        <span className="sigil">{sigilOf(line.type)}</span>
        <span className="text">
          {ranges && ranges.length
            ? highlightLineWithDiff(line.text, lang, ranges, "diff-word")
            : highlightLine(line.text, lang)}
        </span>
        {active && !suppressBtn && (
          <button
            className="comment-btn"
            title="Click to comment, or drag to select a range"
            aria-label="Comment on this line or selection"
            onClick={() => openComment(side, lineNo)}
            {...commentButtonProps(side, lineNo)}
          >
            <Icon name="plus" size={12} />
          </button>
        )}
      </td>
    </>
  );
}

// Not finely memoized (per-side data is recomputed each render); content-visibility
// bounds the cost to on-screen files. The common unified path keeps LineRow's memo.
function SplitRow({
  left,
  right,
  leftData,
  rightData,
  lang,
  gutterProps,
  rowProps,
  commentButtonProps,
  openComment,
  editors,
  onChanged,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
  leftData: SideResolved;
  rightData: SideResolved;
  lang: string | null;
  gutterProps: LineSelection["gutterProps"];
  rowProps: LineSelection["rowProps"];
  commentButtonProps: LineSelection["commentButtonProps"];
  openComment: (side: Side, lineNo: number) => void;
  editors: string[];
  onChanged: () => void;
}) {
  const sideArgs = { lang, gutterProps, rowProps, commentButtonProps, openComment };
  return (
    <>
      <tr className="line split-line">
        <SplitSide
          line={left}
          side="old"
          resolved={leftData}
          suppressBtn={leftData.form !== null}
          {...sideArgs}
        />
        <SplitSide
          line={right}
          side="new"
          resolved={rightData}
          suppressBtn={rightData.form !== null}
          {...sideArgs}
        />
      </tr>
      {[...leftData.threads, ...rightData.threads].map((t) => (
        <tr className="inline-thread-row" key={`${t.id}:${t.status}`}>
          <td className="code" colSpan={4}>
            <InlineThread thread={t} editors={editors} onChanged={onChanged} />
          </td>
        </tr>
      ))}
      {leftData.form && (
        <tr className="comment-form-row">
          <td className="code" colSpan={4}>
            {leftData.form}
          </td>
        </tr>
      )}
      {rightData.form && (
        <tr className="comment-form-row">
          <td className="code" colSpan={4}>
            {rightData.form}
          </td>
        </tr>
      )}
    </>
  );
}

/** Split (side-by-side) hunk body: 4-column [old gutter | old code | new …] rows. */
function SplitHunkRows(p: HunkRowsProps) {
  const ctx: SideCtx = {
    threadsByLine: p.threadsByLine,
    wordRangesByLine: p.wordRangesByLine,
    selRange: p.selRange,
    form: p.form,
    renderForm: p.renderForm,
  };
  const rowArgs = {
    lang: p.lang,
    gutterProps: p.gutterProps,
    rowProps: p.rowProps,
    commentButtonProps: p.commentButtonProps,
    openComment: p.openComment,
    editors: p.editors,
    onChanged: p.onChanged,
  };
  return (
    <>
      {p.gap && !p.exp && (
        <tr className="unfold-row">
          <td className="ln" />
          <td className="code" colSpan={3}>
            <UnfoldButton hi={p.hi} gap={p.gap} unfold={p.unfold} />
          </td>
        </tr>
      )}
      {p.exp?.map((line, li) => (
        <tr className="line line-context" key={`x${li}`}>
          <td className="ln ln-filler" />
          <td className="code line-context">
            <CodeText text={line.text} lang={p.lang} />
          </td>
          <td className="ln">{line.new}</td>
          <td className="code line-context">
            <CodeText text={line.text} lang={p.lang} />
          </td>
        </tr>
      ))}
      <tr className="hunk-header">
        <td className="ln" />
        <td className="code" colSpan={3}>
          {p.hunk.header}
        </td>
      </tr>
      {alignRows(p.hunk.lines).map((row, ri) => (
        <SplitRow
          key={ri}
          left={row.left}
          right={row.right}
          leftData={sideProps(row.left, "old", ctx)}
          rightData={sideProps(row.right, "new", ctx)}
          {...rowArgs}
        />
      ))}
    </>
  );
}
