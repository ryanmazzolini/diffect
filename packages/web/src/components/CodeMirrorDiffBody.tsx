import { useEffect, useMemo, useRef } from "react";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
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
}

export function CodeMirrorDiffBody({ path, content, wrap, theme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const language = useMemo(() => codeMirrorLanguage(path), [path]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || content.old === null || content.new === null) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content.new,
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
            original: content.old,
            mergeControls: false,
            gutter: true,
            highlightChanges: false,
            allowInlineDiffs: false,
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
    return () => view.destroy();
  }, [content.old, content.new, language, theme, wrap]);

  if (content.old === null || content.new === null) {
    return <div className="cm-diff-unavailable">CodeMirror preview needs readable old/new file content.</div>;
  }
  return <div className="cm-diff-host" ref={hostRef} />;
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

function codeMirrorLanguage(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
    case "avsc":
      return json();
    case "yaml":
    case "yml":
      return yaml();
    default:
      return [];
  }
}
