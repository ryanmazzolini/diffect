import { useState } from "react";
import type { RefList } from "@diffect/shared";

const QUICK = ["work", "staged", "unstaged"];

interface Props {
  target: string;
  onTarget: (target: string) => void;
  refs: RefList | null;
}

/**
 * Review-target selector: quick work/staged/unstaged, GitHub-style base…compare
 * dropdowns (branches/tags/recent commits), and a raw ref/range escape hatch.
 */
export function TargetPicker({ target, onTarget, refs }: Props) {
  const [base, setBase] = useState("");
  const [compare, setCompare] = useState("HEAD");
  const [raw, setRaw] = useState("");

  const options = refs
    ? ["HEAD", ...refs.branches, ...refs.tags, ...refs.commits.map((c) => c.sha)]
    : [];

  const applyCompare = (b: string, c: string) => {
    setBase(b);
    setCompare(c);
    if (b && c) onTarget(`${b}...${c}`); // three-dot, like GitHub compare
  };

  const isQuick = QUICK.includes(target);

  return (
    <span className="target-picker">
      <select
        className="selector target-select"
        value={isQuick ? target : ""}
        onChange={(e) => e.target.value && onTarget(e.target.value)}
        title="Quick target"
      >
        {QUICK.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        {!isQuick && <option value="">{target}</option>}
      </select>

      {refs && options.length > 0 && (
        <span className="compare">
          <select
            className="selector"
            value={base}
            onChange={(e) => applyCompare(e.target.value, compare)}
            title="Base"
          >
            <option value="">base…</option>
            {options.map((r) => (
              <option key={`b-${r}`} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span className="compare-sep">…</span>
          <select
            className="selector"
            value={compare}
            onChange={(e) => applyCompare(base, e.target.value)}
            title="Compare"
          >
            {options.map((r) => (
              <option key={`c-${r}`} value={r}>
                {r}
              </option>
            ))}
          </select>
        </span>
      )}

      <input
        className="selector raw-target"
        placeholder="ref or a..b"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && raw.trim()) onTarget(raw.trim());
        }}
        title="Raw ref or range — press Enter to apply"
      />
    </span>
  );
}
