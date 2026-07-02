interface Props {
  additions: number;
  deletions: number;
}

/** Quiet diffstat: "+N −N", no block squares. */
export function DiffStat({ additions, deletions }: Props) {
  return (
    <span
      className="diffstat"
      role="img"
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      <span className="diffstat-add">+{additions}</span>
      <span className="diffstat-del">&minus;{deletions}</span>
    </span>
  );
}
