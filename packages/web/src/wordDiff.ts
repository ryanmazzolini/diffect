/**
 * Word-level (intra-line) diff between a removed line and its paired added line,
 * returning the changed character ranges on each side. Lets the renderer tint
 * just the words that actually changed, instead of the whole line — the readable
 * touch git-diff-view/GitHub use.
 */
export type Range = [start: number, end: number];
export interface WordDiff {
  del: Range[];
  add: Range[];
}

interface Token {
  text: string;
  start: number;
}

// Words (incl. numbers/underscore) stay whole; whitespace runs group; every other
// character is its own token. Granular enough to read, not so granular it's noise.
function tokenize(s: string): Token[] {
  return [...s.matchAll(/\w+|\s+|[^\w\s]/g)].map((m) => ({
    text: m[0],
    start: m.index,
  }));
}

/** Longest-common-subsequence flags: which tokens on each side are unchanged. */
function lcsCommon(a: string[], b: string[]): { aCommon: boolean[]; bCommon: boolean[] } {
  const n = a.length;
  const m = b.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const aCommon = new Array<boolean>(n).fill(false);
  const bCommon = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aCommon[i] = true;
      bCommon[j] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return { aCommon, bCommon };
}

/** Merge runs of changed tokens into character ranges. */
function changedRanges(tokens: Token[], common: boolean[]): Range[] {
  const out: Range[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (common[i]) continue;
    const start = tokens[i]!.start;
    let end = start + tokens[i]!.text.length;
    while (i + 1 < tokens.length && !common[i + 1]) {
      i++;
      end = tokens[i]!.start + tokens[i]!.text.length;
    }
    out.push([start, end]);
  }
  return out;
}

export function wordDiff(oldText: string, newText: string): WordDiff {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const { aCommon, bCommon } = lcsCommon(
    a.map((t) => t.text),
    b.map((t) => t.text),
  );
  // If nothing meaningful is shared it's a full rewrite — tinting the whole line
  // adds noise, not signal, so skip intra-line highlighting entirely.
  const sharedWord = a.some((t, i) => aCommon[i] && t.text.trim() !== "");
  if (!sharedWord) return { del: [], add: [] };
  return { del: changedRanges(a, aCommon), add: changedRanges(b, bCommon) };
}
