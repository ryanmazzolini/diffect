import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  DiffViewWithMultiSelect,
  DiffFile as LibDiffFile,
  DiffModeEnum,
  SplitSide,
  type DiffViewWithMultiSelectRef,
  type LineRange,
  type MultiSelectResult,
  type MultiSelectState,
} from "@git-diff-view/react";
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
const DIFF_RENDERER_KEY = "diffect-diff-renderer";
type DiffRenderer = "git" | "cm6";
type CodeMirrorInteractionMode = "review" | "edit";

function initialDiffRenderer(): DiffRenderer {
  if (typeof window === "undefined") return "cm6";
  const requested = new URLSearchParams(window.location.search).get("renderer");
  if (requested === "cm6" || requested === "git") {
    window.localStorage.setItem(DIFF_RENDERER_KEY, requested);
    return requested;
  }
  return window.localStorage.getItem(DIFF_RENDERER_KEY) === "git" ? "git" : "cm6";
}

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
  viewed: Set<string>;
  /** Side-by-side rendering when true, inline (unified) when false. */
  split: boolean;
  /** Wrap long lines when true; scroll horizontally when false. */
  wrap: boolean;
  theme: Theme;
  onToggleViewed: (path: string) => void;
  /** A tracked file outside the current diff selected from the All files sidebar. */
  previewFile: string | null;
  onBackToDiff: () => void;
  onChanged: () => void;
  editors: string[];
  editor: string | null;
  onEditor: (editor: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}

// Memoized: re-renders only when the diff/threads/viewed-set actually change —
// not on scroll-spy active-file updates, pane resizes, or filter changes.
export const DiffView = memo(function DiffView({
  repo,
  worktree,
  diff,
  files,
  threads,
  viewed,
  split,
  wrap,
  theme,
  onToggleViewed,
  previewFile,
  onBackToDiff,
  onChanged,
  editors,
  editor,
  onEditor,
  onOpenFile,
}: Props) {
  const [renderer] = useState<DiffRenderer>(initialDiffRenderer);
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
  const mode = split ? DiffModeEnum.Split : DiffModeEnum.Unified;
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
            viewed={viewed.has(file.path)}
            mode={mode}
            renderer={renderer}
            wrap={wrap}
            theme={theme}
            deletedSyntaxHighlightMaxLength={deletedSyntaxHighlightMaxLength}
            localDaemon={localDaemon}
            onToggleViewed={onToggleViewed}
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
    for (const l of hunk.lines) {
      out.push(sigil(l.type) + l.text);
      // Round-trip git's no-trailing-newline marker so the renderer's content
      // check lines up with the real file content on either side.
      if (l.noNewline) out.push("\\ No newline at end of file");
    }
  }
  // Terminate every line — git's output always ends in a newline (even after a
  // marker), and @git-diff-view reads a diff that doesn't as an un-terminated
  // final line, which mismatches content that does end in a newline.
  return out.join("\n") + "\n";
}

interface SelectionComment {
  side: Side;
  start: number;
  end: number;
}

interface LineWidgetData {
  threads: Thread[];
  selection: SelectionComment | null;
}

function emptyLineWidgetData(): LineWidgetData {
  return { threads: [], selection: null };
}

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

/** Thread/form bucket keyed by line number, split by side — git-diff-view's extendData shape. */
function buildExtendData(
  threads: Thread[],
  selection: SelectionComment | null,
): {
  oldFile: Record<string, { data: LineWidgetData }>;
  newFile: Record<string, { data: LineWidgetData }>;
} {
  const oldFile: Record<string, { data: LineWidgetData }> = {};
  const newFile: Record<string, { data: LineWidgetData }> = {};
  for (const t of threads) {
    if (t.line === null || t.side === null) continue;
    const bucket = t.side === "old" ? oldFile : newFile;
    const renderLine = Math.max(t.line, t.endLine ?? t.line);
    (bucket[String(renderLine)] ??= { data: emptyLineWidgetData() }).data.threads.push(t);
  }
  if (selection) {
    const bucket = selection.side === "old" ? oldFile : newFile;
    (bucket[String(selection.end)] ??= { data: emptyLineWidgetData() }).data.selection = selection;
  }
  return { oldFile, newFile };
}

const RANGE_HIGHLIGHT_CLASS = "diff-range-commented";

function clearRangeHighlights(root: HTMLElement): void {
  root
    .querySelectorAll(`.${RANGE_HIGHLIGHT_CLASS}`)
    .forEach((el) => el.classList.remove(RANGE_HIGHLIGHT_CLASS));
}

function addRangeHighlight(root: HTMLElement, { side, start, end }: SelectionComment): void {
  for (let line = start; line <= end; line += 1) {
    root
      .querySelectorAll<HTMLElement>(`.diff-line-${side}-num span[data-line-num="${line}"]`)
      .forEach((span) => {
        const numberCell = span.closest(`.diff-line-${side}-num`);
        const contentCell = numberCell
          ?.closest("tr[data-line]")
          ?.querySelector(`.diff-line-${side}-content`);
        numberCell?.classList.add(RANGE_HIGHLIGHT_CLASS);
        contentCell?.classList.add(RANGE_HIGHLIGHT_CLASS);
      });

    root
      .querySelectorAll<HTMLElement>(`.diff-line-num span[data-line-${side}-num="${line}"]`)
      .forEach((span) => {
        const numberCell = span.closest(".diff-line-num");
        const contentCell = numberCell
          ?.closest("tr[data-line]")
          ?.querySelector(".diff-line-content");
        numberCell?.classList.add(RANGE_HIGHLIGHT_CLASS);
        contentCell?.classList.add(RANGE_HIGHLIGHT_CLASS);
      });
  }
}

function threadRange(thread: Thread): SelectionComment | null {
  if (thread.line === null || thread.side === null) return null;
  const end = thread.endLine ?? thread.line;
  return {
    side: thread.side,
    start: Math.min(thread.line, end),
    end: Math.max(thread.line, end),
  };
}

const toSide = (side: SplitSide): Side => (side === SplitSide.old ? "old" : "new");

function rangeLines(a: number, b: number): number[] {
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function readLineFromElement(el: HTMLElement | null, side: Side): number | null {
  if (!el) return null;
  const splitNum =
    el.closest(`.diff-line-${side}-num`) ??
    el.closest(`.diff-line-${side}-content`)?.parentElement?.querySelector(`.diff-line-${side}-num`);
  const splitLine = splitNum?.querySelector("span[data-line-num]")?.getAttribute("data-line-num");
  if (splitLine && Number.isFinite(Number(splitLine))) return Number(splitLine);

  const unifiedNum =
    el.closest(".diff-line-num") ??
    el.closest("tr[data-line]")?.querySelector(".diff-line-num");
  const attr = side === "old" ? "data-line-old-num" : "data-line-new-num";
  const unifiedLine = unifiedNum?.querySelector(`span[${attr}]`)?.getAttribute(attr);
  return unifiedLine && Number.isFinite(Number(unifiedLine)) ? Number(unifiedLine) : null;
}

function readAddWidgetStart(target: HTMLElement): SelectionComment | null {
  const widget = target.closest(".diff-add-widget-wrapper") as HTMLElement | null;
  const rawSide = widget?.getAttribute("data-add-widget");
  if (rawSide !== "old" && rawSide !== "new") return null;
  const line = readLineFromElement(widget, rawSide);
  return line === null ? null : { side: rawSide, start: line, end: line };
}

// Memoized so a thread change on one file doesn't re-render every other file.
const FileDiff = memo(function FileDiff({
  repo,
  worktree,
  target,
  file,
  threads,
  viewed,
  mode,
  renderer,
  wrap,
  theme,
  deletedSyntaxHighlightMaxLength,
  localDaemon,
  onToggleViewed,
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
  viewed: boolean;
  mode: DiffModeEnum;
  renderer: DiffRenderer;
  wrap: boolean;
  theme: Theme;
  deletedSyntaxHighlightMaxLength: number;
  localDaemon: boolean;
  onToggleViewed: (path: string) => void;
  onChanged: () => void;
  editors: string[];
  editor: string | null;
  onEditor: (editor: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  // Real old/new content for the diff's two sides, fetched lazily once the body
  // mounts. Giving git-diff-view the content (vs. just the diff) switches it to
  // the "merge" compose path, which (a) enables expandable collapsed context and
  // (b) stops its dev-mode self-check from warning about a file it can't
  // reconstruct. `null` = still loading; `"error"` = fetch failed, render
  // diff-only as a fallback.
  const [content, setContent] = useState<FileContent | "error" | null>(null);

  const splitView = mode === DiffModeEnum.Split;
  const canUseCodeMirror = renderer === "cm6" && !splitView && readableFileContent(content);
  const editableTarget = localDaemon && (target === "work" || target === "unstaged");
  const deletedFile = file.status === "deleted";
  const canEditCodeMirror = canUseCodeMirror && editableTarget && !deletedFile;
  const showCodeMirrorModeToggle = canUseCodeMirror || editableTarget;
  const [codeMirrorMode, setCodeMirrorModeState] = useState<CodeMirrorInteractionMode>("review");
  const [codeMirrorDirty, setCodeMirrorDirty] = useState(false);
  const codeMirrorEditable = canEditCodeMirror && codeMirrorMode === "edit";
  const unavailableEditTitle = deletedFile
    ? "Deleted files can’t be edited here"
    : editableTarget && splitView
      ? "Edit is unavailable in split view; switch to unified"
      : editableTarget && !canUseCodeMirror
        ? "Edit is unavailable until CodeMirror can load this file"
        : "Edit is only available for working tree changes";
  const editModeTitle = codeMirrorEditable
    ? "Edit mode: saves write to the working tree"
    : canEditCodeMirror
      ? "Review mode: comments enabled; switch to edit to change this file"
      : unavailableEditTitle;
  const editModeClass = codeMirrorEditable ? "editable" : canEditCodeMirror ? "review" : "readonly";
  const editModeLabel = codeMirrorEditable ? "Edit" : canEditCodeMirror ? "Review" : "Read-only";
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

  // Build + initialize the legacy lib's DiffFile only when CM6 cannot handle this
  // file yet. Split view intentionally stays on the read-only legacy renderer;
  // unified CM6 owns the explicit review/edit modes.
  const diffFile = useMemo(() => {
    if (content === null || canUseCodeMirror) return null; // wait for content before first render
    const c = content === "error" ? null : content;
    const f = LibDiffFile.createInstance({
      oldFile: {
        fileName: file.oldPath ?? file.path,
        fileLang: langForPath(file.oldPath ?? file.path) ?? undefined,
        content: c?.old ?? undefined,
      },
      newFile: {
        fileName: file.path,
        fileLang: langForPath(file.path) ?? undefined,
        content: c?.new ?? undefined,
      },
      hunks: [toFullDiff(file)],
    });
    f.init();
    f.buildSplitDiffLines();
    f.buildUnifiedDiffLines();
    return f;
  }, [file, content, canUseCodeMirror]);
  const multiSelectRef = useRef<DiffViewWithMultiSelectRef>(null);
  const [selectionComment, setSelectionComment] = useState<SelectionComment | null>(null);
  const extendData = useMemo(
    () => buildExtendData(threads, selectionComment),
    [threads, selectionComment],
  );
  const rangeHighlights = useMemo(
    () => [
      ...threads.map(threadRange).filter((r): r is SelectionComment => r !== null),
      ...(selectionComment ? [selectionComment] : []),
    ],
    [threads, selectionComment],
  );
  // Click-to-collapse the diff body; seeded from "viewed" so viewed files start
  // collapsed. Marking a file viewed/unviewed (here or anywhere) drives the
  // collapse via the effect; clicking the header still toggles it independently.
  const [collapsed, setCollapsed] = useState(viewed);
  useEffect(() => {
    setCollapsed(viewed);
  }, [viewed]);

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
    setSelectionComment(null);
    setCodeMirrorModeState("review");
    setCodeMirrorDirty(false);
    multiSelectRef.current?.clearSelection();
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
  // still collapsed — so expanding a viewed file is instant instead of a
  // blank-then-pop. Fetches once per identity (content reset clears it).
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
  const showBody = mounted && content !== null && (canUseCodeMirror || diffFile !== null);
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

  useEffect(() => {
    const root = bodyRef.current;
    if (!showBody || !root) return;
    clearRangeHighlights(root);
    rangeHighlights.forEach((range) => addRangeHighlight(root, range));
    return () => clearRangeHighlights(root);
  }, [showBody, rangeHighlights, mode, wrap]);

  const closeSelectionComment = useCallback((onUpdate?: () => void) => {
    setSelectionComment(null);
    multiSelectRef.current?.clearSelection();
    onUpdate?.();
  }, []);

  const showSelectedRange = useCallback((side: Side, start: number, end: number) => {
    const lines = rangeLines(start, end);
    multiSelectRef.current?.setPreselectedLines({
      old: side === "old" ? lines : [],
      new: side === "new" ? lines : [],
    });
  }, []);

  const onAddWidgetMouseDownCapture = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const start = readAddWidgetStart(e.target as HTMLElement);
      if (!start) return;

      e.preventDefault();
      e.stopPropagation();
      setSelectionComment(null);
      showSelectedRange(start.side, start.start, start.end);

      const drag = { ...start };
      const updateEnd = (clientX: number, clientY: number) => {
        const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        const line = readLineFromElement(el, drag.side);
        if (line === null) return;
        drag.end = line;
        showSelectedRange(drag.side, drag.start, drag.end);
      };
      const onMove = (ev: MouseEvent) => updateEnd(ev.clientX, ev.clientY);
      const onUp = (ev: MouseEvent) => {
        document.removeEventListener("mousemove", onMove);
        updateEnd(ev.clientX, ev.clientY);
        setSelectionComment({
          side: drag.side,
          start: Math.min(drag.start, drag.end),
          end: Math.max(drag.start, drag.end),
        });
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, { once: true });
    },
    [showSelectedRange],
  );

  const onMultiSelectChange = useCallback(
    (_range: LineRange | null, state: MultiSelectState) => {
      if (state.isSelecting) setSelectionComment(null);
    },
    [],
  );

  const onMultiSelectComplete = useCallback((result: MultiSelectResult) => {
    const start = Math.min(result.range.startLineNumber, result.range.endLineNumber);
    const end = Math.max(result.range.startLineNumber, result.range.endLineNumber);
    if (start === end) return;
    setSelectionComment({ side: result.range.side === "old" ? "old" : "new", start, end });
  }, []);

  // Existing threads, plus a pending multi-line comment form under the selected range.
  const renderExtendLine = useCallback(
    ({ data, onUpdate }: { data: LineWidgetData; onUpdate: () => void }) => (
      <div className="lib-thread-stack">
        {data.threads.map((t) => (
          <InlineThread
            key={`${t.id}:${t.status}`}
            thread={t}
            onChanged={() => {
              onChanged();
              onUpdate();
            }}
          />
        ))}
        {data.selection && (
          <div className="lib-selection-widget">
            <CommentForm
              repo={repo}
              worktree={worktree}
              target={target}
              file={file.path}
              side={data.selection.side}
              line={data.selection.start}
              endLine={data.selection.end}
              onCancel={() => closeSelectionComment(onUpdate)}
              onCreated={() => {
                closeSelectionComment(onUpdate);
                onChanged();
              }}
            />
          </div>
        )}
      </div>
    ),
    [closeSelectionComment, file.path, onChanged, repo, target, worktree],
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
            target={target}
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
    [repo, worktree, target, file.path, onChanged],
  );

  const threadCount = threads.length;
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;

  return (
    <div
      className={`file${viewed ? " viewed" : ""}`}
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
          <span
            className={`edit-mode-badge ${editModeClass}`}
            title={editModeTitle}
          >
            {editModeLabel}
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
                Review
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
                Edit
              </button>
            </div>
          )}
          <OpenInMenu
            className="file-open-in-menu"
            editors={editors}
            editor={editor}
            onEditor={onEditor}
            primaryAction={() => onOpenFile(file.path)}
          />
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
      </div>
      {!collapsed &&
        (showBody ? (
          <div
            ref={bodyRef}
            className={`file-body${canUseCodeMirror ? " cm6-file-body" : ""}${codeMirrorEditable ? " edit-mode" : ""}`}
            onMouseDownCapture={onAddWidgetMouseDownCapture}
          >
            {canUseCodeMirror ? (
              <Suspense fallback={<div className="cm-diff-unavailable">Loading CodeMirror renderer…</div>}>
                <CodeMirrorDiffBody
                  repo={repo}
                  worktree={worktree}
                  target={target}
                  file={file}
                  content={content}
                  threads={threads}
                  wrap={wrap}
                  theme={theme}
                  deletedSyntaxHighlightMaxLength={deletedSyntaxHighlightMaxLength}
                  skipsDeletedSyntaxHighlight={skipsDeletedSyntaxHighlight}
                  editable={codeMirrorEditable}
                  onSave={saveCodeMirrorContent}
                  onChanged={onChanged}
                  onDirtyChange={setCodeMirrorDirty}
                />
              </Suspense>
            ) : (
              <DiffViewWithMultiSelect<LineWidgetData>
                ref={multiSelectRef}
                diffFile={diffFile!}
                extendData={extendData}
                diffViewMode={mode}
                diffViewWrap={wrap}
                diffViewTheme={theme}
                diffViewHighlight
                diffViewAddWidget
                enableMultiSelect
                onMultiSelectChange={onMultiSelectChange}
                onMultiSelectComplete={onMultiSelectComplete}
                onAddWidgetClick={() => setSelectionComment(null)}
                renderExtendLine={renderExtendLine}
                renderWidgetLine={renderWidgetLine}
              />
            )}
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

