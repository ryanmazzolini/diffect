import { useEffect, useRef } from "react";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { FileContent } from "@diffect/shared";
import type { Theme } from "../theme.js";

interface Props {
  path: string;
  content: FileContent;
  wrap: boolean;
  theme: Theme;
  deletedSyntaxHighlightMaxLength: number;
  skipsDeletedSyntaxHighlight: boolean;
}

export function CodeMirrorDiffBody({
  path,
  content,
  wrap,
  theme,
  deletedSyntaxHighlightMaxLength,
  skipsDeletedSyntaxHighlight,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const oldText = content.old;
    const newText = content.new;
    if (!host || oldText === null || newText === null) return;

    let cancelled = false;
    let view: EditorView | null = null;

    void codeMirrorLanguage(path).catch(() => []).then((language) => {
      if (cancelled) return;
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: newText,
          extensions: [
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            EditorView.contentAttributes.of({
              spellcheck: "false",
              autocorrect: "off",
              autocapitalize: "off",
            }),
            lineNumbers(),
            language,
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
    });

    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [content.old, content.new, deletedSyntaxHighlightMaxLength, path, theme, wrap]);

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
      <div className="cm-diff-host" ref={hostRef} />
    </>
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
