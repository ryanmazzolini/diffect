interface Props {
  additions: number;
  deletions: number;
  /** Hide the numeric "+N −N" and show only the square block (e.g. tight tree rows). */
  countsHidden?: boolean;
}

/**
 * GitHub-style diffstat: "+N −N" plus a five-square block whose green/red fill is
 * proportional to the add/del ratio. Purely presentational.
 */
export function DiffStat({ additions, deletions, countsHidden = false }: Props) {
  const blocks = diffBlocks(additions, deletions);
  return (
    <span className="diffstat">
      {!countsHidden && (
        <>
          <span className="diffstat-add">+{additions}</span>
          <span className="diffstat-del">&minus;{deletions}</span>
        </>
      )}
      <span
        className="diffstat-blocks"
        aria-label={`${additions} additions, ${deletions} deletions`}
      >
        {blocks.map((kind, i) => (
          <span key={i} className={`diffstat-block diffstat-block-${kind}`} />
        ))}
      </span>
    </span>
  );
}

type Block = "add" | "del" | "neutral";

/** Distribute five squares across add/del proportionally, neutral for the rest. */
function diffBlocks(additions: number, deletions: number): Block[] {
  const total = additions + deletions;
  let greens = total ? Math.round((additions / total) * 5) : 0;
  let reds = total ? Math.round((deletions / total) * 5) : 0;
  // Never round a real change down to zero squares.
  if (additions > 0 && greens === 0) greens = 1;
  if (deletions > 0 && reds === 0) reds = 1;
  // Rounding can overshoot five; trim the larger share back, biasing ties toward
  // green (additions) the way GitHub's block does.
  while (greens + reds > 5) reds >= greens ? reds-- : greens--;
  const neutral = 5 - greens - reds;
  return [
    ...Array<Block>(greens).fill("add"),
    ...Array<Block>(reds).fill("del"),
    ...Array<Block>(neutral).fill("neutral"),
  ];
}
