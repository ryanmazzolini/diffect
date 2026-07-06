import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  crosshairCursor,
  gutter,
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
  theme: Theme;
  deletedSyntaxHighlightMaxLength: number;
  skipsDeletedSyntaxHighlight: boolean;
  editable: boolean;
  onSave: (content: string) => Promise<void>;
  onChanged: () => void;
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

class CommentGutterMarker extends GutterMarker {
  constructor(
    private readonly targets: LineTarget[],
    private readonly allTargets: LineTarget[],
    private readonly onSelect: (selection: SelectionComment) => void,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-comment-marker";
    for (const target of this.targets) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "diff-add-widget cm-diff-add-widget";
      button.tabIndex = -1;
      button.textContent = "+";
      button.title = `Comment on ${target.side} line ${target.line}`;
      button.setAttribute("aria-label", `Comment on ${target.side} line ${target.line}`);
      button.dataset.side = target.side;
      button.dataset.line = String(target.line);
      button.addEventListener("pointerdown", (event) => this.startDrag(event, view, target));
      wrap.append(button);
    }
    return wrap;
  }

  override eq() {
    return false;
  }

  private startDrag(event: PointerEvent, view: EditorView, start: LineTarget) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);

    let end = start.line;
    const select = () => {
      this.onSelect({
        side: start.side,
        start: Math.min(start.line, end),
        end: Math.max(start.line, end),
      });
    };
    const updateEnd = (ev: PointerEvent) => {
      const line = targetLineFromDom(ev, start.side) ??
        targetLineAtPoint(view, this.allTargets, start.side, ev.clientX, ev.clientY);
      if (line !== null) end = line;
    };
    const onMove = (ev: PointerEvent) => {
      updateEnd(ev);
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      updateEnd(ev);
      select();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }
}

export function CodeMirrorDiffBody({
  repo,
  worktree,
  target,
  file,
  content,
  threads,
  wrap,
  theme,
  deletedSyntaxHighlightMaxLength,
  skipsDeletedSyntaxHighlight,
  editable,
  onSave,
  onChanged,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savingRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [selectionComment, setSelectionComment] = useState<SelectionComment | null>(null);
  const [viewVersion, setViewVersion] = useState(0);

  const saveCurrent = useCallback(async () => {
    const view = viewRef.current;
    if (!view || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveMessage("");
    try {
      await onSave(view.state.doc.toString());
      setDirty(false);
      setSaveMessage("Saved");
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : "Save failed");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onSave]);

  const closeSelectionComment = useCallback(() => {
    setSelectionComment(null);
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
    setSaveMessage("");
    setSelectionComment(null);
    let cancelled = false;

    void codeMirrorLanguage(file.path).catch(() => []).then((language) => {
      if (cancelled) return;
      const anchors = buildLineAnchors(file, countDocLines(newText));
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: newText,
          extensions: [
            EditorState.readOnly.of(!editable),
            EditorView.editable.of(editable),
            EditorView.contentAttributes.of({
              spellcheck: "false",
              autocorrect: "off",
              autocapitalize: "off",
              "aria-label": `${file.path} diff editor`,
            }),
            lineNumbers(),
            cmCommentGutter(anchors, setSelectionComment),
            cmDecorations,
            rectangularSelection({
              eventFilter: (event) => event.button === 1 || (event.button === 0 && event.altKey),
            }),
            crosshairCursor({ key: "Alt" }),
            language,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) setDirty(update.state.doc.toString() !== newText);
            }),
            editable
              ? keymap.of([
                  {
                    key: "Mod-s",
                    run: () => {
                      void saveCurrent();
                      return true;
                    },
                  },
                ])
              : [],
            syntaxHighlighting(diffectHighlightStyle),
            unifiedMergeView({
              original: oldText,
              mergeControls: false,
              gutter: true,
              highlightChanges: false,
              allowInlineDiffs: false,
              syntaxHighlightDeletionsMaxLength: deletedSyntaxHighlightMaxLength,
              collapseUnchanged: { margin: 3, minSize: 8 },
            }),
            wrap ? EditorView.lineWrapping : [],
            EditorView.theme(
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
                  backgroundColor: "var(--add-ink)",
                  color: "var(--panel)",
                },
                ".cm-deletedLineGutter": {
                  backgroundColor: "var(--del-ink)",
                  color: "var(--panel)",
                },
              },
              { dark: theme === "dark" },
            ),
          ],
        }),
      });
      viewRef.current = view;
      setViewVersion((version) => version + 1);
    });

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [content.old, content.new, deletedSyntaxHighlightMaxLength, editable, file, saveCurrent, theme, wrap]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const anchors = buildLineAnchors(file, view.state.doc.lines);
    view.dispatch({
      effects: setCmDecorations.of(
        buildCmDecorations(view, anchors, threads, selectionComment, renderLineWidget),
      ),
    });
    view.requestMeasure();
  }, [file, renderLineWidget, selectionComment, threads, viewVersion]);

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
      {editable && (
        <div className="cm-diff-editbar">
          <span>Editable working-tree file</span>
          <button type="button" className="ghost mini" onClick={() => void saveCurrent()} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {saveMessage && <span className="cm-save-status">{saveMessage}</span>}
        </div>
      )}
      <div className="cm-diff-host" ref={hostRef} />
    </>
  );
}

function cmCommentGutter(
  anchors: LineAnchors,
  onSelect: (selection: SelectionComment) => void,
): Extension {
  return gutter({
    class: "cm-comment-gutter",
    initialSpacer: () => new CommentGutterSpacer(),
    lineMarker(view, line) {
      const docLine = view.state.doc.lineAt(line.from).number;
      const targets = anchors.targetsByDocLine.get(docLine);
      return targets ? new CommentGutterMarker(targets, anchors.targets, onSelect) : null;
    },
  });
}

function buildCmDecorations(
  view: EditorView,
  anchors: LineAnchors,
  threads: Thread[],
  selection: SelectionComment | null,
  renderLineWidget: (data: CmLineWidgetData) => ReactNode,
): DecorationSet {
  const decorations = [];
  for (const range of rangeHighlights(threads, selection)) {
    for (const lineNumber of rangeLines(range.start, range.end)) {
      const docLine = docLineFor(anchors, range.side, lineNumber, view.state.doc.lines);
      const line = view.state.doc.line(docLine);
      decorations.push(Decoration.line({ class: "cm-range-commented" }).range(line.from));
    }
  }
  for (const data of lineWidgetData(threads, selection)) {
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

function rangeHighlights(threads: Thread[], selection: SelectionComment | null): SelectionComment[] {
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
  if (selection) ranges.push(selection);
  return ranges;
}

function rangeLines(start: number, end: number): number[] {
  return Array.from({ length: Math.abs(end - start) + 1 }, (_, i) => Math.min(start, end) + i);
}

function docLineFor(anchors: LineAnchors, side: Side, line: number, docLines: number): number {
  return clampDocLine(anchors[side].get(line) ?? line, docLines);
}

function targetLineFromDom(event: MouseEvent | PointerEvent, side: Side): number | null {
  const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>("button.cm-diff-add-widget");
  if (button?.dataset.side !== side) return null;
  const line = Number(button.dataset.line);
  return Number.isFinite(line) ? line : null;
}

function targetLineAtPoint(
  view: EditorView,
  targets: LineTarget[],
  side: Side,
  clientX: number,
  clientY: number,
): number | null {
  const pos = view.posAtCoords({ x: clientX, y: clientY });
  const docLine = pos === null
    ? view.state.doc.lineAt(view.lineBlockAtHeight((clientY - view.documentTop) / view.scaleY).from).number
    : view.state.doc.lineAt(pos).number;
  const sameSide = targets.filter((target) => target.side === side);
  const exact = sameSide.find((target) => target.docLine === docLine);
  if (exact) return exact.line;
  if (side === "new") return docLine;
  let nearest: LineTarget | null = null;
  for (const target of sameSide) {
    if (!nearest || Math.abs(target.docLine - docLine) < Math.abs(nearest.docLine - docLine)) {
      nearest = target;
    }
  }
  return nearest?.line ?? null;
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

function countDocLines(text: string): number {
  return Math.max(1, text.split("\n").length);
}

function clampDocLine(line: number, docLines: number): number {
  return Math.min(Math.max(1, line), Math.max(1, docLines));
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
