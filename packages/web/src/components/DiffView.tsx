import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DiffFile, DiffHunk, FileContent, RepoDiff, Side, Thread } from "@diffect/shared";
import type { Theme } from "../theme.js";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { highlightLine, langForPath } from "../highlight.js";
import { fileElementId } from "../fileTree.js";
import { CommentForm } from "./CommentForm.js";
import { FullFilePreview } from "./FullFilePreview.js";
import { DiffStat } from "./DiffStat.js";
import { OpenInMenu } from "./OpenInMenu.js";
import { InlineThread } from "./InlineThread.js";

// Stable empty array so memoized children don't see a fresh [] each render.
const EMPTY_THREADS: Thread[] = [];

// Scroll-windowing: a file's (heavy) library body is only mounted while the file
// is within this many px of the viewport, so wrap/theme/repo-switch — which all
// scale with *mounted* lines — stay O(visible) instead of O(whole diff). Far
// offscreen files render a height-preserving placeholder instead.
const MOUNT_MARGIN_PX = 1200;
const EST_ROW_PX = 20; // rough diff-row height, for placeholder/intrinsic sizing
const DEFAULT_DELETED_SYNTAX_HIGHLIGHT_MAX_LENGTH = 12_000;
const DELETED_SYNTAX_HIGHLIGHT_MAX_QUERY = "cm6DeletedSyntaxHighlightMax";
const CodeMirrorDiffBody = lazy(() =>
  import("./CodeMirrorDiffBody.js").then((m) => ({ default: m.CodeMirrorDiffBody })),
);
type CodeMirrorInteractionMode = "review" | "edit";



function initialDeletedSyntaxHighlightMaxLength(): number {
  if (typeof window === "undefined") return DEFAULT_DELETED_SYNTAX_HIGHLIGHT_MAX_LENGTH;
  const raw = new URLSearchParams(window.location.search).get(DELETED_SYNTAX_HIGHLIGHT_MAX_QUERY);
  if (raw === null) return DEFAULT_DELETED_SYNTAX_HIGHLIGHT_MAX_LENGTH;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_DELETED_SYNTAX_HIGHLIGHT_MAX_LENGTH;
}

function isLocalOrigin(): boolean {
  if (typeof window === "undefined") return false;
  return ["127.0.0.1", "::1", "localhost"].includes(window.location.hostname);
}

interface Props {
  repo: string;
  worktree: string | null;
  diff: RepoDiff | null;
  /** Files in display (tree) order — matches the sidebar so scrolling tracks it. */
  files: DiffFile[];
  threads: Thread[];
  /** Side-by-side rendering when true, inline (unified) when false. */
  split: boolean;
  /** Wrap long lines when true; scroll horizontally when false. */
  wrap: boolean;
  theme: Theme;
  /** A tracked file outside the current diff selected from the All files sidebar. */
  previewFile: string | null;
  onBackToDiff: () => void;
  onChanged: () => void;
  editors: string[];
  editor: string | null;
  onEditor: (editor: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}

// Memoized: re-renders only when the diff/threads actually change — not on
// scroll-spy active-file updates, pane resizes, or filter changes.
export const DiffView = memo(function DiffView({
  repo,
  worktree,
  diff,
  files,
  threads,
  split,
  wrap,
  theme,
  previewFile,
  onBackToDiff,
  onChanged,
  editors,
  editor,
  onEditor,
  onOpenFile,
}: Props) {
  const [deletedSyntaxHighlightMaxLength] = useState(initialDeletedSyntaxHighlightMaxLength);
  const [localDaemon] = useState(isLocalOrigin);
  // One pass to bucket threads by file, kept stable across renders so each file
  // gets a referentially-stable array (memo can then skip unchanged files).
  const threadsByFile = useMemo(() => groupThreadsByFile(threads), [threads]);
  if (!diff) {
    return <div className="loading">Loading diff…</div>;
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
  const showingPreview =
    previewFile !== null && !files.some((f) => f.path === previewFile || f.oldPath === previewFile);

  return (
    <div className="diff">
      {showingPreview ? (
        <FullFilePreview
          repo={repo}
          worktree={worktree}
          target={diff.target}
          file={previewFile}
          threads={threadsByFile.get(previewFile) ?? EMPTY_THREADS}
          onBackToDiff={onBackToDiff}
          onChanged={onChanged}
          editors={editors}
          editor={editor}
          onEditor={onEditor}
          onOpenFile={onOpenFile}
        />
      ) : files.length === 0 ? (
        <div className="empty">
          No changes in this target. Try a different compare target above, or choose
          All files in the sidebar to comment on unchanged files.
        </div>
      ) : (
        files.map((file) => (
          <FileDiff
            key={file.path}
            repo={repo}
            worktree={worktree}
            target={diff.target}
            file={file}
            threads={threadsByFile.get(file.path) ?? EMPTY_THREADS}
            split={split}
            wrap={wrap}
            theme={theme}
            deletedSyntaxHighlightMaxLength={deletedSyntaxHighlightMaxLength}
            localDaemon={localDaemon}
            onChanged={onChanged}
            editors={editors}
            editor={editor}
            onEditor={onEditor}
            onOpenFile={onOpenFile}
          />
        ))
      )}
      {!showingPreview && outOfDiff.map(([file, fileThreads]) => (
        <OutOfDiffFile
          key={file}
          repo={repo}
          worktree={worktree}
          file={file}
          threads={fileThreads}
          onChanged={onChanged}
          editors={editors}
          editor={editor}
          onEditor={onEditor}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
});

function readableFileContent(content: FileContent | "error" | null): content is { old: string; new: string } {
  return content !== null && content !== "error" && content.old !== null && content.new !== null;
}

function hasDeletedBlockOver(file: DiffFile, maxLength: number): boolean {
  let blockLength = 0;
  for (const hunk of file.hunks) {
    blockLength = 0;
    for (const line of hunk.lines) {
      if (line.type !== "del") {
        blockLength = 0;
        continue;
      }
      blockLength += line.text.length + 1;
      if (blockLength > maxLength) return true;
    }
  }
  return false;
}

// Memoized so a thread change on one file doesn't re-render every other file.
const FileDiff = memo(function FileDiff({
  repo,
  worktree,
  target,
  file,
  threads,
  split,
  wrap,
  theme,
  deletedSyntaxHighlightMaxLength,
  localDaemon,
  onChanged,
  editors,
  editor,
  onEditor,
  onOpenFile,
}: {
  repo: string;
  worktree: string | null;
  target: string;
  file: DiffFile;
  threads: Thread[];
  split: boolean;
  wrap: boolean;
  theme: Theme;
  deletedSyntaxHighlightMaxLength: number;
  localDaemon: boolean;
  onChanged: () => void;
  editors: string[];
  editor: string | null;
  onEditor: (editor: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  // Real old/new content for the diff's two sides, fetched lazily once the body
  // mounts. `null` = still loading; `"error"` = fetch failed, render a readable
  // unavailable state rather than mounting CodeMirror.
  const [content, setContent] = useState<FileContent | "error" | null>(null);

  const canUseCodeMirror = readableFileContent(content);
  const editableTarget = localDaemon && (target === "work" || target === "unstaged");
  const deletedFile = file.status === "deleted";
  const canEditCodeMirror = canUseCodeMirror && editableTarget && !deletedFile;
  const showCodeMirrorModeToggle = canUseCodeMirror || editableTarget;
  const [codeMirrorMode, setCodeMirrorModeState] = useState<CodeMirrorInteractionMode>("review");
  const [codeMirrorDirty, setCodeMirrorDirty] = useState(false);
  const codeMirrorEditable = canEditCodeMirror && codeMirrorMode === "edit";
  const unavailableEditTitle = deletedFile
    ? "Deleted files can’t be edited here"
    : editableTarget && split
      ? "Edit is unavailable in split view; switch to unified"
      : editableTarget && !canUseCodeMirror
        ? "Edit is unavailable until CodeMirror can load this file"
        : "Edit is only available for working tree changes";
  const setCodeMirrorMode = useCallback(
    (nextMode: CodeMirrorInteractionMode) => {
      if (nextMode === "review" && codeMirrorDirty && !window.confirm("Discard unsaved edits and return to review mode?")) {
        return;
      }
      setCodeMirrorModeState(nextMode);
    },
    [codeMirrorDirty],
  );
  const skipsDeletedSyntaxHighlight =
    canUseCodeMirror && hasDeletedBlockOver(file, deletedSyntaxHighlightMaxLength);

  const saveCodeMirrorContent = useCallback(
    async (nextContent: string) => {
      await api.writeFileContent(repo, {
        path: file.path,
        target,
        worktree,
        content: nextContent,
      });
      setContent((current) =>
        current && current !== "error" ? { ...current, new: nextContent } : current,
      );
      onChanged();
    },
    [file.path, onChanged, repo, target, worktree],
  );

  // Click-to-collapse the diff body; clicking the header toggles it independently.
  const [collapsed, setCollapsed] = useState(false);

  // Scroll-windowing. `near` starts false so the initial render is just headers
  // + placeholders (a big diff paints instantly); an IntersectionObserver then
  // mounts the bodies in view and unmounts those scrolled far away.
  const fileRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const measuredHeight = useRef<number | null>(null);
  const [near, setNear] = useState(false);
  // Reset cached content + measured height when the diff identity changes (new
  // target/file/worktree). FileDiff is keyed by path, so a target switch reuses
  // the instance — without this, the next diff would briefly show the previous
  // file's body or reserve its (wrong) placeholder height. Keyed on scalars so
  // an unrelated new-but-equal `file` reference can't trigger a needless refetch.
  useEffect(() => {
    setContent(null);
    setCodeMirrorModeState("review");
    setCodeMirrorDirty(false);
    measuredHeight.current = null;
  }, [repo, worktree, target, file.path, file.oldPath]);
  useEffect(() => {
    const el = fileRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        // The observer may coalesce entries for the target; the last is current.
        const entry = entries[entries.length - 1];
        if (entry) setNear(entry.isIntersecting);
      },
      { rootMargin: `${MOUNT_MARGIN_PX}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // Prefetch content as soon as the file is near the viewport — even while it's
  // still collapsed — so expanding a file is instant instead of a blank-then-pop.
  // Fetches once per identity (content reset clears it).
  const mounted = !collapsed && near;
  useEffect(() => {
    if (!near || content !== null) return;
    let live = true;
    api
      .fileContent(repo, { path: file.path, oldPath: file.oldPath, target, worktree })
      .then((c) => live && setContent(c))
      .catch(() => live && setContent("error"));
    return () => {
      live = false;
    };
  }, [near, content, repo, worktree, target, file.path, file.oldPath]);

  // The body only renders once content has arrived and the selected renderer is ready.
  const showBody = mounted && content !== null && canUseCodeMirror;
  // Remember the real rendered height so the placeholder reserves the same space
  // when the body unmounts (keeps the scrollbar stable). ResizeObserver also
  // catches height changes from a wrap/mode toggle while mounted.
  useEffect(() => {
    if (!showBody) return;
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.offsetHeight > 0) measuredHeight.current = el.offsetHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showBody]);
  // Placeholder/intrinsic height estimate from line count, for files that have
  // never mounted yet.
  const estHeight = useMemo(() => {
    const rows = file.hunks.reduce((n, h) => n + h.lines.length + 1, 0);
    return Math.max(120, rows * EST_ROW_PX);
  }, [file]);

  const threadCount = threads.length;
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;

  return (
    <div
      className="file"
      id={fileElementId(repo, file.path)}
      data-path={file.path}
      ref={fileRef}
      style={{ containIntrinsicSize: `auto ${measuredHeight.current ?? estHeight}px` }}
    >
      <div className={`file-header${collapsed ? " collapsed" : ""}${codeMirrorEditable ? " edit-mode" : ""}`}>
        <button
          type="button"
          className="fh-main"
          aria-expanded={!collapsed}
          title={collapsed ? "Expand this file" : "Collapse this file"}
          onClick={() => setCollapsed((c) => !c)}
        >
          <Icon name="chevron-down" size={12} className="fh-chev" />
          <span className={`status status-${file.status}`}>{file.status}</span>
          {file.ignored && <span className="ignored-badge">ignored</span>}
          <span className="file-path">
            {dir && <span className="fp-dir">{dir}</span>}
            {base}
          </span>
          <DiffStat additions={file.additions} deletions={file.deletions} />
          {threadCount > 0 && (
            <span className="fh-threads">
              {threadCount} thread{threadCount === 1 ? "" : "s"}
            </span>
          )}
        </button>
        <div className="right">
          {showCodeMirrorModeToggle && (
            <div className="cm-mode-toggle" role="group" aria-label={`CodeMirror mode for ${file.path}`}>
              <button
                type="button"
                className={codeMirrorMode === "review" || !codeMirrorEditable ? "active" : ""}
                aria-pressed={codeMirrorMode === "review" || !codeMirrorEditable}
                title="Review mode: comment on the diff"
                onClick={() => setCodeMirrorMode("review")}
              >
                <Icon name="eye" size={13} />
                <span className="sr-only">Comment on diff</span>
              </button>
              <button
                type="button"
                className={codeMirrorEditable ? "active" : ""}
                aria-pressed={codeMirrorEditable}
                disabled={!canEditCodeMirror}
                title={canEditCodeMirror ? "Edit mode: change this file" : unavailableEditTitle}
                onClick={() => setCodeMirrorMode("edit")}
              >
                <Icon name="code" size={13} />
                <span className="sr-only">Edit file</span>
              </button>
            </div>
          )}
          <OpenInMenu
            className="file-open-in-menu"
            editors={editors}
            editor={editor}
            onEditor={onEditor}
            primaryAction={() => onOpenFile(file.path)}
            compact
          />
        </div>
      </div>
      {!collapsed &&
        (showBody ? (
          <div
            ref={bodyRef}
            className={`file-body${canUseCodeMirror ? " cm6-file-body" : ""}${codeMirrorEditable ? " edit-mode" : ""}`}
          >
            <Suspense fallback={<div className="cm-diff-unavailable">Loading CodeMirror renderer…</div>}>
              <CodeMirrorDiffBody
                repo={repo}
                worktree={worktree}
                target={target}
                file={file}
                content={content}
                threads={threads}
                wrap={wrap}
                split={split}
                theme={theme}
                deletedSyntaxHighlightMaxLength={deletedSyntaxHighlightMaxLength}
                skipsDeletedSyntaxHighlight={skipsDeletedSyntaxHighlight}
                editable={codeMirrorEditable}
                onSave={saveCodeMirrorContent}
                onChanged={onChanged}
                onDirtyChange={setCodeMirrorDirty}
              />
            </Suspense>
          </div>
        ) : (
          <div
            className="file-body-placeholder"
            style={{ height: measuredHeight.current ?? estHeight }}
            aria-hidden="true"
          />
        ))}
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
  onChanged,
  editors,
  editor,
  onEditor,
  onOpenFile,
}: {
  repo: string;
  worktree: string | null;
  file: string;
  threads: Thread[];
  onChanged: () => void;
  editors: string[];
  editor: string | null;
  onEditor: (editor: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  return (
    <div className="file out-of-diff" id={fileElementId(repo, file)} data-path={file}>
      <div className="file-header">
        <span className="status status-context">context</span>
        <span className="file-path">{file}</span>
        <span className="out-of-diff-tag">not in this diff</span>
        <OpenInMenu
          className="file-open-in-menu"
          editors={editors}
          editor={editor}
          onEditor={onEditor}
          primaryAction={() => onOpenFile(file)}
        />
      </div>
      {threads.map((t) => (
        <OutOfDiffThread
          key={t.id}
          repo={repo}
          worktree={worktree}
          file={file}
          thread={t}
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
  onChanged,
}: {
  repo: string;
  worktree: string | null;
  file: string;
  thread: Thread;
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
            <InlineThread thread={thread} onChanged={onChanged} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

