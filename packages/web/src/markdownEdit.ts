/**
 * Pure textarea-selection transforms for the markdown toolbar. Each takes the
 * current value + selection and returns the new value with the selection to
 * restore, so the editor stays a controlled component.
 */
export interface EditResult {
  value: string;
  selStart: number;
  selEnd: number;
}

/** Wrap the selection in `before`/`after`; with no selection, place the caret between. */
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string = before,
): EditResult {
  const sel = value.slice(start, end);
  const next = value.slice(0, start) + before + sel + after + value.slice(end);
  const selStart = start + before.length;
  return { value: next, selStart, selEnd: selStart + sel.length };
}

/** Prefix every line overlapping the selection (per-line index for ordered lists). */
export function prefixLines(
  value: string,
  start: number,
  end: number,
  prefix: (index: number) => string,
): EditResult {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = value.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd);
  const transformed = block
    .split("\n")
    .map((line, i) => prefix(i) + line)
    .join("\n");
  const next = value.slice(0, lineStart) + transformed + value.slice(lineEnd);
  return { value: next, selStart: lineStart, selEnd: lineStart + transformed.length };
}

/** Insert a `[text](url)` link, selecting the placeholder URL for quick replace. */
export function insertLink(value: string, start: number, end: number): EditResult {
  const text = value.slice(start, end) || "text";
  const inserted = `[${text}](url)`;
  const next = value.slice(0, start) + inserted + value.slice(end);
  const urlStart = start + text.length + 3; // past "[text]("
  return { value: next, selStart: urlStart, selEnd: urlStart + 3 }; // selects "url"
}
