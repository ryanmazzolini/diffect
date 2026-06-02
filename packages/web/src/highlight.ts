import { common, createLowlight } from "lowlight";
import { createElement, type ReactNode } from "react";

// Minimal structural view of the hast nodes lowlight returns (avoids a dep on
// @types/hast for the two shapes we render).
type HastNode =
  | { type: "text"; value: string }
  | {
      type: "element";
      properties?: { className?: string[] | string };
      children: HastNode[];
    };

// highlight.js core with the common language set. Per-line highlighting keeps the
// diff render synchronous and fast; multi-line constructs (block comments) may not
// carry across line boundaries, an acceptable trade for speed.
const lowlight = createLowlight(common);
const LANGS = new Set(lowlight.listLanguages());

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  xml: "xml",
  vue: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  rb: "ruby",
  php: "php",
  swift: "swift",
  scala: "scala",
};

/** Resolve a highlight.js language for a path, or null when unsupported. */
export function langForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  const lang = ext ? EXT_LANG[ext] : undefined;
  return lang && LANGS.has(lang) ? lang : null;
}

/**
 * Highlight one line of code into React element nodes (never raw HTML injection).
 * Returns the plain text when there's no language match or highlighting throws.
 */
export function highlightLine(text: string, lang: string | null): ReactNode {
  if (!lang) return text;
  try {
    const tree = lowlight.highlight(lang, text);
    return (tree.children as HastNode[]).map((n, i) => toReact(n, i));
  } catch {
    return text; // unknown grammar quirk: fall back to plain text
  }
}

function toReact(node: HastNode, key: number): ReactNode {
  if (node.type === "text") return node.value;
  const cls = node.properties?.className;
  const className = Array.isArray(cls) ? cls.join(" ") : cls;
  return createElement(
    "span",
    { key, className },
    node.children.map((c, i) => toReact(c, i)),
  );
}
