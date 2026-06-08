import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RefList, RefSearchOption, RefSearchResults } from "@diffect/shared";
import { api } from "../api.js";

const LOCAL_TARGETS = [
  { target: "work", label: "All local changes", short: "All" },
  { target: "staged", label: "Staged changes", short: "Staged" },
  { target: "unstaged", label: "Unstaged changes", short: "Unstaged" },
];

interface Props {
  repo: string;
  worktree: string | null;
  defaultBranch: string | null;
  target: string;
  onTarget: (target: string) => void;
  refs: RefList | null;
}

/**
 * GitHub-like review-target selector: local review modes plus searchable
 * base…compare pickers for branches, tags, and commits.
 */
export function TargetPicker({
  repo,
  worktree,
  defaultBranch,
  target,
  onTarget,
  refs,
}: Props) {
  const fallbackBase = useMemo(
    () => defaultBranch ?? refs?.branches.find((b) => b === "main") ?? refs?.branches[0] ?? "",
    [defaultBranch, refs],
  );
  const [base, setBase] = useState(fallbackBase);
  const [compare, setCompare] = useState("HEAD");
  const fallbackResults = useMemo(() => refsToSearchResults(refs), [refs]);

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
          onSelect={(option) => applyCompare(base || fallbackBase, option.value)}
        />
      </span>

      <span className="local-targets" aria-label="Local review modes">
        {LOCAL_TARGETS.map((mode) => (
          <button
            key={mode.target}
            type="button"
            className={`target-mode ${target === mode.target ? "active" : ""}`}
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
  onSelect: (option: RefSearchOption) => void;
}

function RefSearchPicker({
  label,
  repo,
  worktree,
  selectedValue,
  fallbackResults,
  onSelect,
}: RefSearchPickerProps) {
  const buttonId = useId();
  const inputId = useId();
  const listId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const [open, setOpen] = useState(false);
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
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const groups = useMemo(() => groupedOptions(results, query), [results, query]);
  const flat = groups.flatMap((group) => group.options);
  const hasResults = flat.length > 0;

  const choose = (option: RefSearchOption) => {
    onSelect(option);
    setOpen(false);
    setQuery("");
  };

  return (
    <span className="ref-picker" ref={rootRef}>
      <button
        id={buttonId}
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

      {open && (
        <span className="ref-popover" role="dialog" aria-labelledby={buttonId}>
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
      )}
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
  return LOCAL_TARGETS.some((mode) => mode.target === target);
}

function displayRefValue(value: string): string {
  if (/^[0-9a-f]{12,40}$/i.test(value)) return value.slice(0, 7);
  if (value.startsWith("tags/")) return value.slice("tags/".length);
  return value;
}
