import { useEffect, useRef } from "react";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import type { FileContent } from "@diffect/shared";
import type { Theme } from "../theme.js";

interface Props {
  content: FileContent;
  wrap: boolean;
  theme: Theme;
}

export function CodeMirrorDiffBody({ content, wrap, theme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

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
          lineNumbers(),
          unifiedMergeView({
            original: content.old,
            mergeControls: false,
            gutter: true,
            highlightChanges: true,
            allowInlineDiffs: true,
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
              ".cm-changedLine": {
                backgroundColor: "var(--add-bg)",
              },
              ".cm-changedText": {
                backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
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
  }, [content.old, content.new, theme, wrap]);

  if (content.old === null || content.new === null) {
    return <div className="cm-diff-unavailable">CodeMirror preview needs readable old/new file content.</div>;
  }
  return <div className="cm-diff-host" ref={hostRef} />;
}
