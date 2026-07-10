import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import {
  getChunks,
  getOriginalDoc,
  MergeView,
  originalDocChangeEffect,
  unifiedMergeView,
} from "@codemirror/merge";
import {
  ChangeSet,
  Compartment,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type ChangeSpec,
  type Extension,
  type Range,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  crosshairCursor,
  drawSelection,
  gutter,
  gutterLineClass,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { DiffFile, FileContent, Side, Thread } from "@diffect/shared";
import type { Theme } from "../theme.js";
import { CommentForm } from "./CommentForm.js";
import { InlineThread } from "./InlineThread.js";

interface Props {
  repo: string;
  worktree: string | null;
  target: string;
  file: DiffFile;
  content: FileContent;
  threads: Thread[];
  wrap: boolean;
  split: boolean;
  theme: Theme;
  deletedSyntaxHighlightMaxLength: number;
  skipsDeletedSyntaxHighlight: boolean;
  editable: boolean;
  onSave: (content: string) => Promise<void>;
  onChanged: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

interface SelectionComment {
  side: Side;
  start: number;
  end: number;
}

interface LineTarget {
  side: Side;
  line: number;
  docLine: number;
}

interface LineAnchors {
  old: Map<number, number>;
  new: Map<number, number>;
  targets: LineTarget[];
  targetsByDocLine: Map<number, LineTarget[]>;
}

type DiffSide = Side | "unified";

interface ViewContext {
  side: DiffSide;
  view: EditorView;
}

interface CmLineWidgetData {
  side: Side;
  line: number;
  threads: Thread[];
  selection: SelectionComment | null;
}

const setCmDecorations = StateEffect.define<DecorationSet>();
const cmDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCmDecorations)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const setCmGutterLineClasses = StateEffect.define<RangeSet<GutterMarker>>();
const cmGutterLineClasses = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(classes, tr) {
    let next = classes.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCmGutterLineClasses)) next = effect.value;
    }
    return next;
  },
  provide: (field) => gutterLineClass.from(field),
});

class ReactBlockWidget extends WidgetType {
  private root: Root | null = null;

  constructor(private readonly render: () => ReactNode) {
    super();
  }

  override toDOM() {
    const dom = document.createElement("div");
    dom.className = "cm-react-widget";
    this.root = createRoot(dom);
    this.root.render(this.render());
    return dom;
  }

  override destroy() {
    this.root?.unmount();
    this.root = null;
  }
}

class CommentGutterSpacer extends GutterMarker {
  override toDOM() {
    const span = document.createElement("span");
    span.className = "cm-comment-spacer";
    span.textContent = "+";
    return span;
  }

  override eq(other: GutterMarker) {
    return other instanceof CommentGutterSpacer;
  }
}

class SelectedGutterLine extends GutterMarker {
  override elementClass = "cm-range-commented-gutter";

  override eq(other: GutterMarker) {
    return other instanceof SelectedGutterLine;
  }
}

class DragEndGutterLine extends GutterMarker {
  override elementClass: string;

  constructor(readonly side: Side) {
    super();
    this.elementClass = `cm-range-drag-end cm-range-drag-end-${side}`;
  }

  override eq(other: GutterMarker) {
    return other instanceof DragEndGutterLine && other.side === this.side;
  }
}

const selectedGutterLine = new SelectedGutterLine();
const dragEndGutterLine = {
  old: new DragEndGutterLine("old"),
  new: new DragEndGutterLine("new"),
};

class CommentGutterMarker extends GutterMarker {
  constructor(
    private readonly targets: LineTarget[],
    private readonly allTargets: LineTarget[],
    private readonly onPreview: (selection: SelectionComment) => void,
    private readonly onCommit: (selection: SelectionComment) => void,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-comment-marker";
    const primary = this.targets.find((target) => target.side === "new") ?? this.targets[0];
    if (!primary) return wrap;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "diff-add-widget cm-diff-add-widget";
    button.tabIndex = -1;
    button.textContent = "+";
    button.dataset.docLine = String(primary.docLine);
    for (const target of this.targets) {
      button.dataset[`${target.side}Line`] = String(target.line);
      button.dataset[`${target.side}DocLine`] = String(target.docLine);
    }
    setCommentButtonTarget(button, primary.side, primary.line);
    button.addEventListener("mousedown", (event) => {
      const side = button.dataset.side === "old" ? "old" : "new";
      const line = Number(button.dataset.line);
      const target = this.allTargets.find((candidate) => candidate.side === side && candidate.line === line) ?? primary;
      startCommentRangeDrag(event, view, target, this.allTargets, this.onPreview, this.onCommit);
    });
    wrap.append(button);
    return wrap;
  }

  override eq(other: GutterMarker) {
    return other instanceof CommentGutterMarker && sameLineTargets(this.targets, other.targets);
  }
}

function sameLineTargets(a: LineTarget[], b: LineTarget[]): boolean {
  return a.length === b.length && a.every((target, index) => {
    const other = b[index];
    return other?.side === target.side && other.line === target.line && other.docLine === target.docLine;
  });
}

function setCommentButtonTarget(button: HTMLButtonElement, side: Side, line: number): void {
  button.dataset.side = side;
  button.dataset.line = String(line);
  button.setAttribute("aria-label", `Comment on ${side} line ${line}`);
}

export function CodeMirrorDiffBody({
  repo,
  worktree,
  target,
  file,
  content,
  threads,
  wrap,
  split,
  theme,
  deletedSyntaxHighlightMaxLength,
  skipsDeletedSyntaxHighlight,
  editable,
  onSave,
  onChanged,
  onDirtyChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mergeViewRef = useRef<MergeView | null>(null);
  const viewContextsRef = useRef<ViewContext[]>([]);
  const anchorCompartmentsRef = useRef<Map<DiffSide, Compartment>>(new Map());
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const splitRef = useRef(split);
  splitRef.current = split;
  const savingRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [selectedRange, setSelectedRange] = useState<SelectionComment | null>(null);
  const [commentRange, setCommentRange] = useState<SelectionComment | null>(null);
  const [viewVersion, setViewVersion] = useState(0);
  const editableUnified = editable && !split;
  const anchorCompartment = useCallback((side: DiffSide) => {
    let compartment = anchorCompartmentsRef.current.get(side);
    if (!compartment) {
      compartment = new Compartment();
      anchorCompartmentsRef.current.set(side, compartment);
    }
    return compartment;
  }, []);

  const saveCurrent = useCallback(async () => {
    const view = viewRef.current;
    if (!view || splitRef.current || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveMessage("");
    try {
      await onSaveRef.current(view.state.doc.toString());
      setDirty(false);
      onDirtyChangeRef.current?.(false);
      setSaveMessage("Saved");
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : "Save failed");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  const closeSelectionComment = useCallback(() => {
    setSelectedRange(null);
    setCommentRange(null);
  }, []);

  const renderLineWidget = useCallback(
    (data: CmLineWidgetData) => (
      <div className="lib-thread-stack cm-thread-stack">
        {data.threads.map((thread) => (
          <InlineThread key={`${thread.id}:${thread.status}`} thread={thread} onChanged={onChanged} />
        ))}
        {data.selection && (
          <div className="lib-selection-widget cm-selection-widget">
            <CommentForm
              repo={repo}
              worktree={worktree}
              target={target}
              file={file.path}
              side={data.selection.side}
              line={data.selection.start}
              endLine={data.selection.end}
              onCancel={closeSelectionComment}
              onCreated={() => {
                closeSelectionComment();
                onChanged();
              }}
            />
          </div>
        )}
      </div>
    ),
    [closeSelectionComment, file.path, onChanged, repo, target, worktree],
  );

  useEffect(() => {
    const host = hostRef.current;
    const oldText = content.old;
    const newText = content.new;
    if (!host || oldText === null || newText === null) return;

    setDirty(false);
    onDirtyChangeRef.current?.(false);
    setSaveMessage("");
    setSelectedRange(null);
    setCommentRange(null);
    let cancelled = false;
    let cleanupHover = () => {};

    void codeMirrorLanguage(file.path).catch(() => []).then((language) => {
      if (cancelled) return;
      const baseExtensions = (side: DiffSide, anchors: LineAnchors, docPath: string): Extension[] => [
        EditorState.readOnly.of(!editableUnified),
        EditorView.editable.of(editableUnified),
        EditorView.contentAttributes.of({
          spellcheck: "false",
          autocorrect: "off",
          autocapitalize: "off",
          "aria-label": `${docPath} ${side === "old" ? "old" : "new"} diff editor`,
        }),
        anchorCompartment(side).of(
          editableUnified
            ? lineNumbers()
            : [
                cmLineNumbers(anchors, setSelectedRange, setCommentRange),
                cmCommentGutter(anchors, setSelectedRange, setCommentRange),
                cmHoverCommentHandle(),
              ],
        ),
        cmDecorations,
        cmGutterLineClasses,
        editableUnified ? [drawSelection(), singleSelectionOnly()] : [],
        editableUnified
          ? []
          : [
              rectangularSelection({
                eventFilter: (event) => event.button === 1 || (event.button === 0 && event.altKey),
              }),
              crosshairCursor({ key: "Alt" }),
            ],
        language,
        EditorView.updateListener.of((update) => {
          if (editableUnified && update.docChanged) {
            setDirty(true);
            onDirtyChangeRef.current?.(true);
          }
        }),
        editableUnified ? history() : [],
        editableUnified
          ? keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  void saveCurrent();
                  return true;
                },
              },
              ...historyKeymap,
            ])
          : [],
        syntaxHighlighting(diffectHighlightStyle),
        wrap ? EditorView.lineWrapping : [],
        cmDiffTheme(theme),
      ];

      if (split) {
        const oldAnchors = buildSideLineAnchors("old", countDocLines(oldText), file);
        const newAnchors = buildSideLineAnchors("new", countDocLines(newText), file);
        const mergeView = new MergeView({
          parent: host,
          a: {
            doc: oldText,
            extensions: baseExtensions("old", oldAnchors, file.oldPath ?? file.path),
          },
          b: {
            doc: newText,
            extensions: baseExtensions("new", newAnchors, file.path),
          },
          orientation: "a-b",
          gutter: true,
          highlightChanges: false,
          collapseUnchanged: { margin: 3, minSize: 8 },
        });
        mergeViewRef.current = mergeView;
        viewRef.current = null;
        viewContextsRef.current = [
          { side: "old", view: mergeView.a },
          { side: "new", view: mergeView.b },
        ];
      } else {
        const anchors = buildLineAnchors(file, countDocLines(newText));
        const view = new EditorView({
          parent: host,
          state: EditorState.create({
            doc: newText,
            extensions: [
              ...baseExtensions("unified", anchors, file.path),
              unifiedMergeView({
                original: oldText,
                mergeControls: false,
                gutter: true,
                highlightChanges: false,
                allowInlineDiffs: false,
                syntaxHighlightDeletionsMaxLength: deletedSyntaxHighlightMaxLength,
                collapseUnchanged: { margin: 3, minSize: 8 },
              }),
            ],
          }),
        });
        viewRef.current = view;
        mergeViewRef.current = null;
        viewContextsRef.current = [{ side: "unified", view }];
      }

      const onMove = (event: MouseEvent) => {
        for (const { view } of viewContextsRef.current) updateHoverCommentHandle(view, event);
      };
      const onLeave = () => {
        for (const { view } of viewContextsRef.current) clearHoverCommentHandles(view);
      };
      if (!editableUnified) {
        host.addEventListener("mousemove", onMove);
        host.addEventListener("mouseleave", onLeave);
        cleanupHover = () => {
          host.removeEventListener("mousemove", onMove);
          host.removeEventListener("mouseleave", onLeave);
        };
      }
      setViewVersion((version) => version + 1);
    });

    return () => {
      cancelled = true;
      cleanupHover();
      viewRef.current?.destroy();
      mergeViewRef.current?.destroy();
      viewRef.current = null;
      mergeViewRef.current = null;
      viewContextsRef.current = [];
    };
    // Content and hunk updates are synchronized into the existing views below.
    // Rebuild only when editor configuration or file identity changes.
  }, [anchorCompartment, deletedSyntaxHighlightMaxLength, editable, editableUnified, file.path, file.oldPath, saveCurrent, split, theme, wrap]);

  useEffect(() => {
    if (editableUnified || content.old === null || content.new === null) return;
    const contexts = viewContextsRef.current;
    if (contexts.length === 0) return;

    for (const { side, view } of contexts) {
      const nextText = side === "old" ? content.old : content.new;
      const currentText = view.state.doc.toString();
      const changes = minimalTextChange(currentText, nextText);
      const anchors = side === "unified"
        ? buildLineAnchors(file, countDocLines(nextText))
        : buildSideLineAnchors(side, countDocLines(nextText), file);
      const effects = [
        anchorCompartment(side).reconfigure([
          cmLineNumbers(anchors, setSelectedRange, setCommentRange),
          cmCommentGutter(anchors, setSelectedRange, setCommentRange),
          cmHoverCommentHandle(),
        ]),
      ];

      if (side === "unified") {
        const currentOriginal = getOriginalDoc(view.state).toString();
        const originalChange = minimalTextChange(currentOriginal, content.old);
        if (originalChange) {
          effects.push(
            originalDocChangeEffect(
              view.state,
              ChangeSet.of(originalChange, currentOriginal.length),
            ),
          );
        }
      }

      view.dispatch({ changes: changes ?? undefined, effects });
    }
  }, [anchorCompartment, content.new, content.old, editableUnified, file, viewVersion]);

  useEffect(() => {
    const contexts = viewContextsRef.current;
    if (contexts.length === 0) return;
    const ranges = rangeHighlights(threads, selectedRange, commentRange);
    for (const { side, view } of contexts) {
      const anchors = side === "unified"
        ? buildLineAnchors(file, view.state.doc.lines)
        : buildSideLineAnchors(side, view.state.doc.lines, file);
      const sideRanges = side === "unified" ? ranges : ranges.filter((range) => range.side === side);
      const sideThreads = side === "unified" ? threads : threads.filter((thread) => thread.side === side);
      const sideCommentRange = !commentRange || side === "unified" || commentRange.side === side ? commentRange : null;
      const dragRange = selectedRange && !commentRange && (side === "unified" || selectedRange.side === side)
        ? selectedRange
        : null;
      const host = view.dom.closest<HTMLElement>(".cm-diff-host") ?? view.dom;
      host.classList.toggle("cm-comment-form-open", commentRange !== null);
      host.classList.toggle("cm-diff-editable", editable && !split);
      view.dispatch({
        effects: [
          setCmDecorations.of(buildCmDecorations(view, anchors, sideRanges, sideThreads, sideCommentRange, renderLineWidget)),
          setCmGutterLineClasses.of(buildCmGutterLineClasses(view, anchors, sideRanges, dragRange)),
        ],
      });
      if (side === "unified") syncDeletedRangeHighlights(view, ranges);
      view.requestMeasure();
    }
  }, [commentRange, content.new, content.old, editable, file, renderLineWidget, selectedRange, split, threads, viewVersion]);

  if (content.old === null || content.new === null) {
    return <div className="cm-diff-unavailable">CodeMirror preview needs readable old/new file content.</div>;
  }
  return (
    <>
      {skipsDeletedSyntaxHighlight && (
        <div className="cm-diff-notice">
          Some deleted lines are shown as plain text to keep this large diff responsive.
        </div>
      )}
      <div className={`cm-diff-shell${editable && !split ? " edit-mode" : ""}${split ? " split-mode" : ""}`}>
        {editable && !split && (
          <div className="cm-diff-save-pill">
            <button type="button" className="ghost mini" onClick={() => void saveCurrent()} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            {saveMessage && <span className="cm-save-status">{saveMessage}</span>}
          </div>
        )}
        <div className="cm-diff-host" ref={hostRef} />
      </div>
    </>
  );
}

function singleSelectionOnly(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (tr.newSelection.ranges.length <= 1) return tr as unknown as TransactionSpec;
    return [
      {
        changes: tr.changes,
        effects: tr.effects,
      },
      {
        selection: tr.newSelection.asSingle(),
        scrollIntoView: tr.scrollIntoView,
        sequential: true,
      },
    ];
  });
}

function cmLineNumbers(
  anchors: LineAnchors,
  onPreview: (selection: SelectionComment) => void,
  onCommit: (selection: SelectionComment) => void,
): Extension {
  return lineNumbers({
    domEventHandlers: {
      mousedown(view, line, event) {
        if (!(event instanceof MouseEvent) || event.button !== 0) return false;
        const target = primaryTargetForDocLine(anchors, view.state.doc.lineAt(line.from).number);
        if (!target) return false;
        startCommentRangeDrag(event, view, target, anchors.targets, onPreview, onCommit);
        return true;
      },
    },
  });
}

function cmCommentGutter(
  anchors: LineAnchors,
  onPreview: (selection: SelectionComment) => void,
  onCommit: (selection: SelectionComment) => void,
): Extension {
  return gutter({
    class: "cm-comment-gutter",
    initialSpacer: () => new CommentGutterSpacer(),
    lineMarker(view, line) {
      const docLine = view.state.doc.lineAt(line.from).number;
      const targets = anchors.targetsByDocLine.get(docLine);
      return targets ? new CommentGutterMarker(targets, anchors.targets, onPreview, onCommit) : null;
    },
  });
}

function clearHoverCommentHandles(view: EditorView): void {
  view.dom
    .closest<HTMLElement>(".cm-diff-host")
    ?.querySelectorAll<HTMLButtonElement>("button.cm-diff-add-widget.cm-hover-line")
    .forEach((button) => button.classList.remove("cm-hover-line"));
}

function updateHoverCommentHandle(view: EditorView, event: MouseEvent): void {
  const host = view.dom.closest<HTMLElement>(".cm-diff-host");
  if (!host || host.classList.contains("cm-range-drag-active") || host.classList.contains("cm-comment-form-open")) {
    return;
  }
  const target = event.target as HTMLElement | null;
  const activeButton = host.querySelector<HTMLButtonElement>("button.cm-diff-add-widget.cm-hover-line");
  const activeGutterElement = activeButton?.closest(".cm-gutterElement");
  if (activeGutterElement && target?.closest(".cm-gutterElement") === activeGutterElement) return;
  const button = target?.closest<HTMLButtonElement>("button.cm-diff-add-widget");

  clearHoverCommentHandles(view);
  if (button) {
    button.classList.add("cm-hover-line");
    return;
  }

  const oldLine = oldDeletedLineAtPoint(view, event.clientX, event.clientY);
  if (oldLine !== null) {
    const oldButton =
      host.querySelector<HTMLButtonElement>(`button.cm-diff-add-widget[data-old-line="${oldLine}"]`) ??
      host.querySelector<HTMLButtonElement>("button.cm-diff-add-widget[data-old-line]");
    if (oldButton) {
      setCommentButtonTarget(oldButton, "old", oldLine);
      oldButton.classList.add("cm-hover-line");
    }
    return;
  }

  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return;
  const docLine = view.state.doc.lineAt(pos).number;
  const newButton = host.querySelector<HTMLButtonElement>(
    `button.cm-diff-add-widget[data-new-doc-line="${docLine}"]`,
  );
  if (newButton && newButton.dataset.newLine) {
    setCommentButtonTarget(newButton, "new", Number(newButton.dataset.newLine));
    newButton.classList.add("cm-hover-line");
    return;
  }
  host.querySelector<HTMLButtonElement>(`button.cm-diff-add-widget[data-doc-line="${docLine}"]`)?.classList.add(
    "cm-hover-line",
  );
}

function cmHoverCommentHandle(): Extension {
  return EditorView.domEventHandlers({
    mousemove(event, view) {
      updateHoverCommentHandle(view, event);
      return false;
    },
    mouseleave(_event, view) {
      clearHoverCommentHandles(view);
      return false;
    },
  });
}

function buildCmDecorations(
  view: EditorView,
  anchors: LineAnchors,
  ranges: SelectionComment[],
  threads: Thread[],
  commentRange: SelectionComment | null,
  renderLineWidget: (data: CmLineWidgetData) => ReactNode,
): DecorationSet {
  const decorations = [];
  for (const range of ranges) {
    for (const lineNumber of rangeLines(range.start, range.end)) {
      const docLine = docLineFor(anchors, range.side, lineNumber, view.state.doc.lines);
      const line = view.state.doc.line(docLine);
      decorations.push(Decoration.line({ class: "cm-range-commented" }).range(line.from));
    }
  }
  for (const data of lineWidgetData(threads, commentRange)) {
    const docLine = docLineFor(anchors, data.side, data.line, view.state.doc.lines);
    const line = view.state.doc.line(docLine);
    decorations.push(
      Decoration.widget({
        widget: new ReactBlockWidget(() => renderLineWidget(data)),
        block: true,
        side: 1,
      }).range(line.to),
    );
  }
  return Decoration.set(decorations, true);
}

function buildCmGutterLineClasses(
  view: EditorView,
  anchors: LineAnchors,
  ranges: SelectionComment[],
  dragRange: SelectionComment | null,
): RangeSet<GutterMarker> {
  const markers: Range<GutterMarker>[] = [];
  for (const range of ranges) {
    for (const lineNumber of rangeLines(range.start, range.end)) {
      const docLine = docLineFor(anchors, range.side, lineNumber, view.state.doc.lines);
      const line = view.state.doc.line(docLine);
      markers.push(selectedGutterLine.range(line.from));
    }
  }
  if (dragRange) {
    const docLine = docLineFor(anchors, dragRange.side, dragRange.end, view.state.doc.lines);
    markers.push(dragEndGutterLine[dragRange.side].range(view.state.doc.line(docLine).from));
  }
  return markers.length === 0 ? RangeSet.empty : RangeSet.of(markers, true);
}

function syncDeletedRangeHighlights(view: EditorView, ranges: SelectionComment[]): void {
  const oldRanges = ranges.filter((range) => range.side === "old");
  const root = view.dom.closest<HTMLElement>(".cm-diff-host") ?? view.dom;
  root
    .querySelectorAll(".cm-deletedLine.cm-range-commented-deleted")
    .forEach((line) => line.classList.remove("cm-range-commented-deleted"));
  if (oldRanges.length === 0) return;

  const chunks = (getChunks(view.state)?.chunks ?? []).filter((chunk) => chunk.fromA < chunk.toA);
  const oldDoc = getOriginalDoc(view.state);
  const deletedChunks = [...root.querySelectorAll<HTMLElement>(".cm-deletedChunk")];
  if (deletedChunks.length > 0) {
    chunks.forEach((chunk, chunkIndex) => {
      const chunkEl = deletedChunks[chunkIndex];
      if (!chunkEl) return;
      const firstLine = oldDoc.lineAt(Math.min(chunk.fromA, oldDoc.length)).number;
      chunkEl.querySelectorAll<HTMLElement>(".cm-deletedLine").forEach((lineEl, offset) => {
        const line = firstLine + offset;
        if (oldRanges.some((range) => line >= range.start && line <= range.end)) {
          lineEl.classList.add("cm-range-commented-deleted");
        }
      });
    });
    return;
  }

  const deletedLines = [...root.querySelectorAll<HTMLElement>(".cm-deletedLine")];
  let deletedLineIndex = 0;
  for (const chunk of chunks) {
    const firstLine = oldDoc.lineAt(Math.min(chunk.fromA, oldDoc.length)).number;
    for (let offset = 0; offset < chunk.toA - chunk.fromA; offset += 1) {
      const lineEl = deletedLines[deletedLineIndex++];
      const line = firstLine + offset;
      if (lineEl && oldRanges.some((range) => line >= range.start && line <= range.end)) {
        lineEl.classList.add("cm-range-commented-deleted");
      }
    }
  }
}

function lineWidgetData(threads: Thread[], selection: SelectionComment | null): CmLineWidgetData[] {
  const byLine = new Map<string, CmLineWidgetData>();
  const get = (side: Side, line: number) => {
    const key = `${side}:${line}`;
    let data = byLine.get(key);
    if (!data) {
      data = { side, line, threads: [], selection: null };
      byLine.set(key, data);
    }
    return data;
  };
  for (const thread of threads) {
    if (thread.line === null || thread.side === null) continue;
    get(thread.side, Math.max(thread.line, thread.endLine ?? thread.line)).threads.push(thread);
  }
  if (selection) get(selection.side, selection.end).selection = selection;
  return [...byLine.values()].sort((a, b) => a.line - b.line || a.side.localeCompare(b.side));
}

function rangeHighlights(
  threads: Thread[],
  selectedRange: SelectionComment | null,
  commentRange: SelectionComment | null,
): SelectionComment[] {
  const ranges: SelectionComment[] = [];
  for (const thread of threads) {
    if (thread.line === null || thread.side === null) continue;
    const end = thread.endLine ?? thread.line;
    ranges.push({
      side: thread.side,
      start: Math.min(thread.line, end),
      end: Math.max(thread.line, end),
    });
  }
  if (selectedRange) ranges.push(selectedRange);
  if (commentRange && commentRange !== selectedRange) ranges.push(commentRange);
  return ranges;
}

function rangeLines(start: number, end: number): number[] {
  return Array.from({ length: Math.abs(end - start) + 1 }, (_, i) => Math.min(start, end) + i);
}

function docLineFor(anchors: LineAnchors, side: Side, line: number, docLines: number): number {
  return clampDocLine(anchors[side].get(line) ?? line, docLines);
}

function primaryTargetForDocLine(anchors: LineAnchors, docLine: number): LineTarget | null {
  const targets = anchors.targetsByDocLine.get(docLine);
  return targets?.find((target) => target.side === "new") ?? targets?.[0] ?? null;
}

function startCommentRangeDrag(
  event: MouseEvent,
  view: EditorView,
  start: LineTarget,
  targets: LineTarget[],
  onPreview: (selection: SelectionComment) => void,
  onCommit: (selection: SelectionComment) => void,
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const dragHandle = event.currentTarget as HTMLElement;
  const root = view.dom.closest<HTMLElement>(".cm-diff-host") ?? view.dom;
  document.body.style.userSelect = "none";
  root.classList.add("cm-range-drag-active");

  let end = start.line;
  let moved = false;
  const selection = () => ({
    side: start.side,
    start: Math.min(start.line, end),
    end: Math.max(start.line, end),
  });
  const preview = () => onPreview(selection());
  preview();
  const updateEnd = (ev: MouseEvent) => {
    const line = targetLineAtPoint(view, targets, start.side, ev.clientX, ev.clientY);
    if (line === null || line === end) return false;
    end = line;
    return true;
  };
  const cleanup = () => {
    document.removeEventListener("mousemove", onMove);
    document.body.style.userSelect = "";
    root.classList.remove("cm-range-drag-active");
  };
  const onMove = (ev: MouseEvent) => {
    if (!updateEnd(ev)) return;
    moved = true;
    preview();
  };
  const onUp = (ev: MouseEvent) => {
    cleanup();
    if (moved) updateEnd(ev);
    const range = selection();
    onPreview(range);
    onCommit(range);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp, { once: true });
}

function targetLineAtPoint(
  view: EditorView,
  targets: LineTarget[],
  side: Side,
  clientX: number,
  clientY: number,
): number | null {
  const bounds = view.dom.getBoundingClientRect();
  if (clientY < bounds.top || clientY > bounds.bottom) return null;

  const deletedLine = side === "old" ? oldDeletedLineAtPoint(view, clientX, clientY) : null;
  if (deletedLine !== null) return deletedLine;

  const pos = view.posAtCoords({ x: clientX, y: clientY });
  const docLine = pos === null
    ? view.state.doc.lineAt(view.lineBlockAtHeight((clientY - view.documentTop) / view.scaleY).from).number
    : view.state.doc.lineAt(pos).number;
  const sameSide = targets.filter((target) => target.side === side);
  const exact = sameSide.find((target) => target.docLine === docLine);
  if (exact) return exact.line;
  if (side === "new") return null;

  let nearest: LineTarget | null = null;
  for (const target of sameSide) {
    if (!nearest || Math.abs(target.docLine - docLine) < Math.abs(nearest.docLine - docLine)) {
      nearest = target;
    }
  }
  return nearest?.line ?? null;
}

function oldDeletedLineAtPoint(view: EditorView, clientX: number, clientY: number): number | null {
  const lineEl = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>(
    ".cm-deletedLine",
  );
  if (!lineEl) return null;

  const chunks = (getChunks(view.state)?.chunks ?? []).filter((candidate) => candidate.fromA < candidate.toA);
  const oldDoc = getOriginalDoc(view.state);
  const chunkEl = lineEl.closest<HTMLElement>(".cm-deletedChunk");
  if (chunkEl) {
    const root = view.dom.closest<HTMLElement>(".cm-diff-host") ?? view.dom;
    const chunkIndex = [...root.querySelectorAll(".cm-deletedChunk")].indexOf(chunkEl);
    const chunk = chunks[chunkIndex];
    if (!chunk) return null;

    const offset = [...chunkEl.querySelectorAll(".cm-deletedLine")].indexOf(lineEl);
    if (offset < 0) return null;
    return oldDoc.lineAt(Math.min(chunk.fromA, oldDoc.length)).number + offset;
  }

  const root = view.dom.closest<HTMLElement>(".cm-diff-host") ?? view.dom;
  let offset = [...root.querySelectorAll(".cm-deletedLine")].indexOf(lineEl);
  if (offset < 0) return null;
  for (const chunk of chunks) {
    const lines = chunk.toA - chunk.fromA;
    if (offset < lines) return oldDoc.lineAt(Math.min(chunk.fromA, oldDoc.length)).number + offset;
    offset -= lines;
  }
  return null;
}

function buildSideLineAnchors(side: Side, docLines: number, file: DiffFile): LineAnchors {
  const old = new Map<number, number>();
  const next = new Map<number, number>();
  const targets: LineTarget[] = [];
  const map = side === "old" ? old : next;
  for (let line = 1; line <= docLines; line += 1) {
    map.set(line, line);
    targets.push({ side, line, docLine: line });
  }

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const actual = side === "old" ? line.old : line.new;
      if (actual === null) continue;
      map.set(actual, clampDocLine(actual, docLines));
    }
  }

  const targetsByDocLine = new Map<number, LineTarget[]>();
  for (const target of targets) targetsByDocLine.set(target.docLine, [target]);
  return { old, new: next, targets, targetsByDocLine };
}

function buildLineAnchors(file: DiffFile, docLines: number): LineAnchors {
  const old = new Map<number, number>();
  const next = new Map<number, number>();
  const targets: LineTarget[] = [];
  const seenTargets = new Set<string>();

  const pushTarget = (side: Side, line: number, docLine: number) => {
    const key = `${side}:${line}`;
    if (seenTargets.has(key)) return;
    seenTargets.add(key);
    targets.push({ side, line, docLine: clampDocLine(docLine, docLines) });
  };

  for (let line = 1; line <= docLines; line += 1) {
    next.set(line, line);
    if (file.status !== "deleted") pushTarget("new", line, line);
  }

  for (const hunk of file.hunks) {
    for (let i = 0; i < hunk.lines.length; i += 1) {
      const line = hunk.lines[i];
      if (!line) continue;
      if (line.new !== null) {
        const docLine = clampDocLine(line.new, docLines);
        next.set(line.new, docLine);
        pushTarget("new", line.new, docLine);
      }
      if (line.old === null) continue;
      if (line.new !== null) {
        old.set(line.old, clampDocLine(line.new, docLines));
        continue;
      }
      const nextNew = hunk.lines.slice(i + 1).find((candidate) => candidate.new !== null)?.new;
      const prevNew = [...hunk.lines.slice(0, i)].reverse().find((candidate) => candidate.new !== null)?.new;
      const docLine = clampDocLine(nextNew ?? prevNew ?? hunk.newStart, docLines);
      old.set(line.old, docLine);
      pushTarget("old", line.old, docLine);
    }
  }

  const targetsByDocLine = new Map<number, LineTarget[]>();
  for (const target of targets) {
    const bucket = targetsByDocLine.get(target.docLine);
    if (bucket) bucket.push(target);
    else targetsByDocLine.set(target.docLine, [target]);
  }
  return { old, new: next, targets, targetsByDocLine };
}

function minimalTextChange(current: string, next: string): ChangeSpec | null {
  if (current === next) return null;
  let prefix = 0;
  const prefixLimit = Math.min(current.length, next.length);
  while (prefix < prefixLimit && current[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(current.length - prefix, next.length - prefix);
  while (
    suffix < suffixLimit &&
    current[current.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return {
    from: prefix,
    to: current.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

function countDocLines(text: string): number {
  return Math.max(1, text.split("\n").length);
}

function clampDocLine(line: number, docLines: number): number {
  return Math.min(Math.max(1, line), Math.max(1, docLines));
}

function cmDiffTheme(theme: Theme): Extension {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--panel)",
        color: "var(--text)",
        fontSize: "13px",
      },
      ".cm-scroller": {
        fontFamily: "var(--mono)",
        lineHeight: "1.5",
      },
      ".cm-gutters": {
        backgroundColor: "var(--panel)",
        color: "var(--muted)",
        borderRight: "1px solid var(--border)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
      },
      ".cm-line": {
        paddingLeft: "12px",
        paddingRight: "16px",
      },
      ".cm-cursor": {
        borderLeftColor: "var(--text)",
      },
      ".cm-deletedChunk": {
        backgroundColor: "var(--del-bg)",
      },
      ".cm-deletedLine": {
        backgroundColor: "var(--del-bg)",
        color: "var(--text)",
        textDecoration: "none",
      },
      ".cm-inlineChangedLine, .cm-changedLine": {
        backgroundColor: "var(--add-bg)",
      },
      ".cm-insertedLine, ins.cm-insertedLine, .cm-insertedLine ins": {
        backgroundColor: "transparent",
        color: "inherit",
        textDecoration: "none",
      },
      "ins": {
        textDecoration: "none",
      },
      ".cm-changedText, .cm-changedText *": {
        backgroundColor: "transparent",
        backgroundImage: "none",
        borderBottom: "none",
        boxShadow: "none",
        textDecoration: "none",
      },
      ".cm-deletedText": {
        backgroundColor: "color-mix(in srgb, var(--del-ink) 20%, transparent)",
        textDecoration: "none",
      },
      ".cm-changedLineGutter": {
        backgroundColor: "transparent",
        boxShadow: "inset 3px 0 0 var(--add-ink)",
        color: "var(--muted)",
      },
      ".cm-deletedLineGutter": {
        backgroundColor: "transparent",
        boxShadow: "inset 3px 0 0 var(--del-ink)",
        color: "var(--muted)",
      },
      ".cm-mergeView": {
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        gap: "0",
      },
      ".cm-mergeViewEditors": {
        display: "contents",
      },
      ".cm-mergeView .cm-editor:first-child": {
        borderRight: "1px solid var(--border)",
      },
    },
    { dark: theme === "dark" },
  );
}

const diffectHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#c678dd" },
  { tag: [tags.string, tags.special(tags.string)], color: "#98c379" },
  { tag: [tags.number, tags.bool, tags.null], color: "#d19a66" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--faint)",
    fontStyle: "italic",
    textDecoration: "none",
  },
  { tag: [tags.propertyName, tags.attributeName], color: "#61afef" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "#e5c07b" },
  { tag: [tags.typeName, tags.className], color: "#56b6c2" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "var(--muted)" },
  { tag: tags.heading, color: "var(--text)", fontWeight: "700" },
  { tag: tags.link, color: "var(--accent-ink)", textDecoration: "none" },
]);

async function codeMirrorLanguage(path: string): Promise<Extension> {
  const filename = path.split("/").pop()?.toLowerCase() ?? path.toLowerCase();
  const ext = filename.split(".").pop();

  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true }));
    case "tsx":
      return import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true }));
    case "js":
    case "mjs":
    case "cjs":
      return import("@codemirror/lang-javascript").then((m) => m.javascript());
    case "jsx":
      return import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true }));
    case "json":
    case "avsc":
      return import("@codemirror/lang-json").then((m) => m.json());
    case "yaml":
    case "yml":
      return import("@codemirror/lang-yaml").then((m) => m.yaml());
    case "md":
    case "markdown":
      return import("@codemirror/lang-markdown").then((m) => m.markdown());
    case "py":
    case "pyw":
      return import("@codemirror/lang-python").then((m) => m.python());
    case "rs":
      return import("@codemirror/lang-rust").then((m) => m.rust());
    case "gd":
      return import("@gdquest/codemirror-gdscript").then((m) => m.gdscript());
    case "rb":
      return import("@codemirror/legacy-modes/mode/ruby").then((m) => StreamLanguage.define(m.ruby));
    case "gql":
    case "graphql":
      return import("cm6-graphql").then((m) => m.graphqlLanguageSupport());
    default:
      if (filename === "gemfile" || filename === "rakefile") {
        return import("@codemirror/legacy-modes/mode/ruby").then((m) => StreamLanguage.define(m.ruby));
      }
      return [];
  }
}
