import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RefList, RefSearchOption, RefSearchResults } from "@diffect/shared";
import { api } from "../api.js";

const STATIC_LOCAL_TARGETS = [
  { target: "staged", label: "Staged changes", short: "Staged" },
  { target: "unstaged", label: "Unstaged changes", short: "Unstaged" },
];

export interface RefThreadCount {
  open: number;
  total: number;
}

interface Props {
  repo: string;
  worktree: string | null;
  defaultBranch: string | null;
  currentBranch?: string | null;
  target: string;
  onTarget: (target: string) => void;
  refs: RefList | null;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
  /**
   * Render each ref popover in a document.body portal, fixed-positioned from its
   * trigger. Needed in the stacked (N≥2) module header, whose `.modmain` scroll
   * container (overflow:auto) would otherwise clip the popover. The N=1 topbar
   * leaves this false: it sits in a non-clipping header, so the popover stays
   * inline exactly as before.
   */
  portalPopover?: boolean;
}

/**
 * GitHub-like review-target selector: local review modes plus searchable
 * base…compare pickers for branches, tags, and commits.
 */
export function TargetPicker({
  repo,
  worktree,
  defaultBranch,
  currentBranch = null,
  target,
  onTarget,
  refs,
  refThreadCounts,
  portalPopover = false,
}: Props) {
  const fallbackBase = useMemo(
    () => defaultBranch ?? refs?.branches.find((b) => b === "main") ?? refs?.branches[0] ?? "",
    [defaultBranch, refs],
  );
  const [base, setBase] = useState(fallbackBase);
  const [compare, setCompare] = useState("HEAD");
  const fallbackResults = useMemo(() => refsToSearchResults(refs), [refs]);
  const localTargets = useMemo(
    () => [
      {
        target: "work",
        label: currentBranch
          ? `Current branch ${currentBranch} plus working tree changes`
          : "Current checkout plus working tree changes",
        short: currentBranch ?? "Current",
      },
      ...STATIC_LOCAL_TARGETS,
    ],
    [currentBranch],
  );

  useEffect(() => {
    const parsed = parseCompareTarget(target);
    if (parsed) {
      setBase(parsed.base);
      setCompare(parsed.compare);
    }
  }, [target]);

  useEffect(() => {
    if (!base && fallbackBase) setBase(fallbackBase);
  }, [base, fallbackBase]);

  useEffect(() => {
    if (isLocalTarget(target) && fallbackBase) setBase(fallbackBase);
  }, [fallbackBase, target]);

  const applyCompare = (nextBase: string, nextCompare: string) => {
    setBase(nextBase);
    setCompare(nextCompare);
    if (nextBase && nextCompare) onTarget(`${nextBase}...${nextCompare}`);
  };

  return (
    <span className="target-picker">
      <span className="compare" aria-label="Base and compare target">
        <span className="compare-label">base</span>
        <RefSearchPicker
          label="Base"
          repo={repo}
          worktree={worktree}
          selectedValue={base}
          fallbackResults={fallbackResults}
          portalPopover={portalPopover}
          onSelect={(option) => applyCompare(option.value, compare || "HEAD")}
        />
        <span className="compare-sep">…</span>
        <span className="compare-label">compare</span>
        <RefSearchPicker
          label="Compare"
          repo={repo}
          worktree={worktree}
          selectedValue={compare}
          fallbackResults={fallbackResults}
          refThreadCounts={refThreadCounts}
          portalPopover={portalPopover}
          onSelect={(option) => applyCompare(base || fallbackBase, option.value)}
        />
      </span>

      <span className="local-targets" aria-label="Local review modes">
        {localTargets.map((mode) => (
          <button
            key={mode.target}
            type="button"
            className={`target-mode ${mode.target === "work" ? "current-branch" : ""} ${target === mode.target ? "active" : ""}`}
            onClick={() => onTarget(mode.target)}
            title={mode.label}
            aria-label={mode.label}
            aria-pressed={target === mode.target}
          >
            {mode.short}
          </button>
        ))}
      </span>

    </span>
  );
}

interface RefSearchPickerProps {
  label: string;
  repo: string;
  worktree: string | null;
  selectedValue: string;
  fallbackResults: RefSearchResults;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
  /** See TargetPicker.Props.portalPopover. */
  portalPopover: boolean;
  onSelect: (option: RefSearchOption) => void;
}

function RefSearchPicker({
  label,
  repo,
  worktree,
  selectedValue,
  fallbackResults,
  refThreadCounts,
  portalPopover,
  onSelect,
}: RefSearchPickerProps) {
  const buttonId = useId();
  const inputId = useId();
  const listId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const [open, setOpen] = useState(false);
  // Fixed viewport coords for the portaled popover; null until first measured
  // (kept hidden so it never flashes at 0,0). Unused in the inline path.
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RefSearchResults>(fallbackResults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) setResults(fallbackResults);
  }, [fallbackResults, open]);

  useEffect(() => {
    if (!open) return;
    const current = ++seq.current;
    setLoading(true);
    setError(null);
    const handle = window.setTimeout(() => {
      api
        .searchRefs(repo, { query, limit: 12, worktree })
        .then((next) => {
          if (current === seq.current) {
            setResults(next);
            setActiveIndex(0);
          }
        })
        .catch((e) => {
          if (current === seq.current) setError(String(e));
        })
        .finally(() => {
          if (current === seq.current) setLoading(false);
        });
    }, query ? 120 : 0);
    return () => window.clearTimeout(handle);
  }, [open, query, repo, worktree]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      // The popover may be portaled out of rootRef (stacked layout), so a click
      // inside it is no longer a DOM descendant of the trigger — check both.
      const node = event.target as Node;
      if (!rootRef.current?.contains(node) && !popoverRef.current?.contains(node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Position the portaled popover against its trigger's viewport rect, flipping
  // above / clamping to stay on-screen. A ResizeObserver re-places it as results
  // load and change its height; scroll/resize keep it pinned to the trigger. The
  // inline (N=1) path never runs this — CSS handles its absolute placement.
  useLayoutEffect(() => {
    if (!open || !portalPopover) return;
    const anchor = rootRef.current;
    const pop = popoverRef.current;
    if (!anchor || !pop) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const margin = 8;
      const ph = pop.offsetHeight;
      const pw = pop.offsetWidth;
      let top = r.bottom + 6;
      if (ph > 0 && top + ph > window.innerHeight - margin && r.top - 6 - ph > margin) {
        top = r.top - 6 - ph;
      }
      if (ph > 0) top = Math.min(top, window.innerHeight - ph - margin);
      top = Math.max(margin, top);
      let left = r.left;
      if (pw > 0) left = Math.min(left, window.innerWidth - pw - margin);
      left = Math.max(margin, left);
      // Bail out when the rect is unchanged so a scroll/resize burst that
      // doesn't move the trigger doesn't re-render the popover every frame.
      setCoords((prev) =>
        prev && prev.top === top && prev.left === left ? prev : { top, left },
      );
    };
    // Capture so we catch scrolls on any ancestor (the popover is pinned to the
    // trigger, which scrolls inside .modmain); passive since we never preventDefault.
    const scrollOpts = { passive: true, capture: true } as const;
    place();
    window.addEventListener("scroll", place, scrollOpts);
    window.addEventListener("resize", place);
    const ro = new ResizeObserver(place);
    ro.observe(pop);
    return () => {
      window.removeEventListener("scroll", place, scrollOpts);
      window.removeEventListener("resize", place);
      ro.disconnect();
      setCoords(null);
    };
  }, [open, portalPopover]);

  const groups = useMemo(() => groupedOptions(results, query), [results, query]);
  const flat = groups.flatMap((group) => group.options);
  const hasResults = flat.length > 0;

  const choose = (option: RefSearchOption) => {
    onSelect(option);
    setOpen(false);
    setQuery("");
    // The portaled popover lives at body level, so closing it would strand focus
    // there; return it to the trigger. The inline (N=1) popover sits inside the
    // trigger's own container, so the browser keeps focus sane — leave it be.
    if (portalPopover) triggerRef.current?.focus();
  };

  const popover = open ? (
    <span
      className="ref-popover"
      role="dialog"
      aria-labelledby={buttonId}
      ref={popoverRef}
      style={
        portalPopover
          ? {
              position: "fixed",
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              visibility: coords ? "visible" : "hidden",
            }
          : undefined
      }
    >
      <label className="sr-only" htmlFor={inputId}>
        Search {label.toLowerCase()} refs
      </label>
      <input
        id={inputId}
        ref={inputRef}
        className="ref-search-input"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={hasResults ? `${listId}-${activeIndex}` : undefined}
        placeholder="Find a branch, tag, or commit…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            if (portalPopover) triggerRef.current?.focus();
          } else if (e.key === "ArrowDown" && hasResults) {
            e.preventDefault();
            setActiveIndex((i) => Math.min(flat.length - 1, i + 1));
          } else if (e.key === "ArrowUp" && hasResults) {
            e.preventDefault();
            setActiveIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && hasResults) {
            e.preventDefault();
            const option = flat[activeIndex];
            if (option) choose(option);
          }
        }}
      />

      <span className="ref-results-meta">
        {loading ? "Searching…" : error ? "Search failed" : "Branches, tags, and commits"}
      </span>
      {error && <span className="ref-search-error">{error}</span>}

      <ul id={listId} className="ref-results" role="listbox" aria-label={`${label} refs`}>
        {!loading && !error && !hasResults && (
          <li className="ref-empty">No refs or commits match “{query}”.</li>
        )}
        {groups.map((group) => (
          <li key={group.title} className="ref-group">
            <span className="ref-group-title">{group.title}</span>
            <ul>
              {group.options.map((option) => {
                const idx = flat.indexOf(option);
                const threadCount = refThreadCounts?.get(option.value);
                const countLabel = refThreadCountLabel(threadCount);
                return (
                  <li key={`${option.kind}-${option.value}`}>
                    <button
                      type="button"
                      id={`${listId}-${idx}`}
                      role="option"
                      aria-selected={idx === activeIndex}
                      className={`ref-option ${idx === activeIndex ? "active" : ""}`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => choose(option)}
                    >
                      <span className="ref-option-main">
                        <span className={option.kind === "commit" ? "ref-sha" : "ref-name"}>
                          {option.label}
                        </span>
                        {option.kind === "commit" && option.subject && (
                          <span className="ref-subject">{option.subject}</span>
                        )}
                        {countLabel && (
                          <span
                            className={`ref-thread-count ${threadCount?.open ? "open" : "closed"}`}
                            title={refThreadCountTitle(threadCount!)}
                          >
                            {countLabel}
                          </span>
                        )}
                      </span>
                      {selectedValue === option.value && <span className="ref-check">✓</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </span>
  ) : null;

  return (
    <span className="ref-picker" ref={rootRef}>
      <button
        id={buttonId}
        ref={triggerRef}
        type="button"
        className="selector ref-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen);
          setQuery("");
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        title={`${label}: ${displayRefValue(selectedValue)}`}
      >
        {displayRefValue(selectedValue) || `Select ${label.toLowerCase()}`}
      </button>

      {portalPopover && popover ? createPortal(popover, document.body) : popover}
    </span>
  );
}

function refsToSearchResults(refs: RefList | null): RefSearchResults {
  return {
    query: "",
    branches: (refs?.branches ?? []).map((name) => ({
      kind: "branch",
      value: name,
      label: name,
    })),
    remotes: (refs?.remotes ?? []).map((name) => ({
      kind: "remote",
      value: name,
      label: name,
    })),
    tags: (refs?.tags ?? []).map((name) => ({
      kind: "tag",
      value: `tags/${name}`,
      label: name,
    })),
    commits: (refs?.commits ?? []).map((commit) => ({
      kind: "commit",
      value: commit.sha,
      label: commit.sha,
      subject: commit.subject,
      sha: commit.sha,
    })),
  };
}

function groupedOptions(results: RefSearchResults, query: string) {
  const needle = query.trim().toLowerCase();
  const headMatches = needle === "" || "head".includes(needle);
  const head: RefSearchOption[] = headMatches
    ? [{ kind: "branch", value: "HEAD", label: "HEAD", subject: "current checkout" }]
    : [];
  return [
    { title: "Branches", options: [...head, ...results.branches] },
    { title: "Remote branches", options: results.remotes },
    { title: "Tags", options: results.tags },
    { title: "Commits", options: results.commits },
  ].filter((group) => group.options.length > 0);
}

function parseCompareTarget(target: string): { base: string; compare: string } | null {
  const op = target.includes("...") ? "..." : target.includes("..") ? ".." : null;
  if (!op) return null;
  const [base, compare] = target.split(op);
  return base && compare ? { base, compare } : null;
}

function isLocalTarget(target: string): boolean {
  return target === "work" || STATIC_LOCAL_TARGETS.some((mode) => mode.target === target);
}

function refThreadCountLabel(count?: RefThreadCount): string | null {
  if (!count || count.total === 0) return null;
  if (count.open > 0) return `${count.open} open`;
  return `${count.total} closed`;
}

function refThreadCountTitle(count: RefThreadCount): string {
  const closed = count.total - count.open;
  return `${count.open} open, ${closed} closed review thread${count.total === 1 ? "" : "s"}`;
}

function displayRefValue(value: string): string {
  if (/^[0-9a-f]{12,40}$/i.test(value)) return value.slice(0, 7);
  if (value.startsWith("tags/")) return value.slice("tags/".length);
  return value;
}
