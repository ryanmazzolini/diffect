import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type {
  RefList,
  RefSearchKind,
  RefSearchOption,
  RefSearchResults,
  ReviewTargetPresentation,
} from "@diffect/shared";
import { api } from "../api.js";

const EMPTY_REPO_LABEL = "empty repo";

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
  preserveWorkTarget?: boolean;
  target: string;
  presentation?: ReviewTargetPresentation;
  onTarget: (target: string, presentation?: ReviewTargetPresentation) => void;
  refs: RefList | null;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
}

/** A task-first review selector with staged/unstaged kept one click away. */
export function TargetPicker({
  repo,
  worktree,
  defaultBranch,
  currentBranch = null,
  preserveWorkTarget = false,
  target,
  presentation,
  onTarget,
  refs,
  refThreadCounts,
}: Props) {
  const fallbackBase = useMemo(
    () => defaultBranch ?? refs?.branches.find((branch) => branch === "main") ?? refs?.branches[0] ?? "",
    [defaultBranch, refs],
  );
  const fallbackResults = useMemo(() => refsToSearchResults(refs), [refs]);
  const repoStartOption = useMemo<RefSearchOption | null>(
    () => refs?.repoStartSha
      ? {
          kind: "commit",
          value: refs.repoStartSha,
          label: EMPTY_REPO_LABEL,
          sha: refs.repoStartSha,
        }
      : null,
    [refs],
  );

  useEffect(() => {
    // `work` uses merge-base semantics, but this control promises the selected
    // branch tip → working tree. Normalize the legacy/default target as soon as
    // the repository's default branch is known so the label and diff agree.
    if (!preserveWorkTarget && target === "work" && fallbackBase) onTarget(fallbackBase);
  }, [fallbackBase, onTarget, preserveWorkTarget, target]);

  return (
    <span className="target-picker">
      <ReviewTargetMenu
        repo={repo}
        worktree={worktree}
        currentBranch={currentBranch}
        target={target}
        presentation={presentation}
        fallbackBase={fallbackBase}
        fallbackResults={fallbackResults}
        repoStartOption={repoStartOption}
        showEmptyRepoOption={refs?.commitsReachRoot === true}
        refThreadCounts={refThreadCounts}
        onTarget={onTarget}
      />
      <span className="local-targets" aria-label="Local review modes">
        {STATIC_LOCAL_TARGETS.map((mode) => (
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

type ReviewScopeMode = "branch" | "compare" | "none";

interface ReviewTargetMenuProps {
  repo: string;
  worktree: string | null;
  currentBranch: string | null;
  target: string;
  presentation?: ReviewTargetPresentation;
  fallbackBase: string;
  fallbackResults: RefSearchResults;
  repoStartOption: RefSearchOption | null;
  showEmptyRepoOption: boolean;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
  onTarget: (target: string, presentation?: ReviewTargetPresentation) => void;
}

function ReviewTargetMenu({
  repo,
  worktree,
  currentBranch,
  target,
  presentation,
  fallbackBase,
  fallbackResults,
  repoStartOption,
  showEmptyRepoOption,
  refThreadCounts,
  onTarget,
}: ReviewTargetMenuProps) {
  const headingId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const coords = usePopoverPosition(open, true, rootRef, popoverRef);
  const triggerLabel = reviewTargetLabel(
    target,
    presentation,
    currentBranch,
    fallbackBase,
    repoStartOption,
  );

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => {
      popoverRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node;
      if (node instanceof Element && node.closest(".ref-popover")) return;
      if (!rootRef.current?.contains(node) && !popoverRef.current?.contains(node)) {
        setOpen(false);
        setRefPickerOpen(false);
        if (!isFocusableClickTarget(node)) {
          window.requestAnimationFrame(() => triggerRef.current?.focus());
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setRefPickerOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const popover = open ? (
    <div
      ref={popoverRef}
      className={`review-target-popover${refPickerOpen ? " ref-picker-open" : ""}`}
      role="dialog"
      aria-labelledby={headingId}
      style={{
        position: "fixed",
        top: coords?.top ?? 0,
        left: coords?.left ?? 0,
        visibility: coords ? "visible" : "hidden",
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close(true);
          return;
        }
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <strong id={headingId} className="review-target-heading">Review changes</strong>
      <LiveReviewScopePicker
        repo={repo}
        worktree={worktree}
        currentBranch={currentBranch}
        target={target}
        presentation={presentation}
        fallbackBase={fallbackBase}
        fallbackResults={fallbackResults}
        repoStartOption={repoStartOption}
        showEmptyRepoOption={showEmptyRepoOption}
        menuRef={popoverRef}
        onPickerOpenChange={setRefPickerOpen}
        refThreadCounts={refThreadCounts}
        onTarget={onTarget}
      />
    </div>
  ) : null;

  return (
    <span className="review-target-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="selector review-target-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerLabel}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span className="review-target-trigger-label">{triggerLabel}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {popover ? createPortal(popover, document.body) : null}
    </span>
  );
}

function LiveReviewScopePicker({
  repo,
  worktree,
  target,
  presentation,
  fallbackBase,
  fallbackResults,
  repoStartOption,
  showEmptyRepoOption,
  menuRef,
  onPickerOpenChange,
  refThreadCounts,
  onTarget,
}: {
  repo: string;
  worktree: string | null;
  currentBranch: string | null;
  target: string;
  presentation?: ReviewTargetPresentation;
  fallbackBase: string;
  fallbackResults: RefSearchResults;
  repoStartOption: RefSearchOption | null;
  showEmptyRepoOption: boolean;
  menuRef: RefObject<HTMLElement>;
  onPickerOpenChange: (open: boolean) => void;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
  onTarget: (target: string, presentation?: ReviewTargetPresentation) => void;
}) {
  const initialParsedTarget = presentation ? null : parseCompareTarget(target);
  const initialBranchRef = branchRefForTarget(target, fallbackBase);
  const [mode, setMode] = useState<ReviewScopeMode>(appliedScopeMode(target, presentation));
  const [branchRef, setBranchRef] = useState(initialBranchRef);
  const [branchLabel, setBranchLabel] = useState(displayRefValue(initialBranchRef));
  const [baseRef, setBaseRef] = useState(
    presentation?.baseRef ?? initialParsedTarget?.base ?? fallbackBase,
  );
  const [baseLabel, setBaseLabel] = useState(
    presentation?.baseIsRepoStart
      ? EMPTY_REPO_LABEL
      : presentation?.baseLabel ?? displayRefValue(initialParsedTarget?.base ?? fallbackBase),
  );
  const [baseIsRepoStart, setBaseIsRepoStart] = useState(
    presentation?.baseIsRepoStart === true ||
      (initialParsedTarget?.op === ".." && initialParsedTarget.base === repoStartOption?.value),
  );
  const [compareRef, setCompareRef] = useState(
    presentation?.compareRef ?? initialParsedTarget?.compare ?? "HEAD",
  );
  const [compareLabel, setCompareLabel] = useState(
    presentation?.compareLabel ?? displayRefValue(initialParsedTarget?.compare ?? "HEAD"),
  );

  useEffect(() => {
    setMode(appliedScopeMode(target, presentation));
    const parsed = presentation ? null : parseCompareTarget(target);
    if (presentation) {
      setBaseRef(presentation.baseRef);
      setBaseLabel(presentation.baseIsRepoStart ? EMPTY_REPO_LABEL : presentation.baseLabel);
      setBaseIsRepoStart(presentation.baseIsRepoStart === true);
      setCompareRef(presentation.compareRef);
      setCompareLabel(presentation.compareLabel);
      return;
    }
    if (parsed) {
      const isRepoStart = parsed.op === ".." && parsed.base === repoStartOption?.value;
      setBaseRef(parsed.base);
      setBaseLabel(isRepoStart ? EMPTY_REPO_LABEL : displayRefValue(parsed.base));
      setBaseIsRepoStart(isRepoStart);
      setCompareRef(parsed.compare);
      setCompareLabel(displayRefValue(parsed.compare));
      return;
    }
    if (isBranchTarget(target)) {
      const nextBranch = branchRefForTarget(target, fallbackBase);
      setBranchRef(nextBranch);
      setBranchLabel(displayRefValue(nextBranch));
    }
  }, [fallbackBase, presentation, repoStartOption?.value, target]);

  useEffect(() => {
    if (mode !== "compare" || !baseRef || !compareRef) return;
    const parsedTarget = parseCompareTarget(target);
    const preservesTwoDotTarget =
      parsedTarget?.op === ".." &&
      parsedTarget.base === baseRef &&
      parsedTarget.compare === compareRef;
    const operator = baseIsRepoStart || preservesTwoDotTarget ? ".." : "...";
    const nextTarget = `${baseRef}${operator}${compareRef}`;
    const presentationMatches =
      !presentation ||
      (presentation.baseRef === baseRef &&
        presentation.baseLabel === baseLabel &&
        presentation.baseIsRepoStart === (baseIsRepoStart || undefined) &&
        presentation.compareRef === compareRef &&
        presentation.compareLabel === compareLabel);
    if (target === nextTarget && presentationMatches) return;
    const timer = window.setTimeout(() => {
      onTarget(nextTarget, {
        kind: "compare",
        baseRef,
        baseLabel,
        ...(baseIsRepoStart ? { baseIsRepoStart: true } : {}),
        compareRef,
        compareLabel,
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    baseIsRepoStart,
    baseLabel,
    baseRef,
    compareLabel,
    compareRef,
    mode,
    onTarget,
    presentation,
    target,
  ]);

  return (
    <div className="review-scope-options">
      <section className="review-scope-section">
        <span className="review-scope-label">Branch</span>
        <RefSearchPicker
          label="Branch"
          repo={repo}
          worktree={worktree}
          selectedValue={branchRef}
          selectedLabel={branchLabel}
          fallbackResults={fallbackResults}
          allowedKinds={["branch", "remote"]}
          includeHead={false}
          placeholder="Find a branch…"
          autoFocus
          portalPopover
          positionAnchorRef={menuRef}
          stayOutsideAnchor
          onOpenChange={onPickerOpenChange}
          onSelect={(option) => {
            setMode("branch");
            setBranchRef(option.value);
            setBranchLabel(option.label);
            onTarget(option.value);
          }}
        />
      </section>

      <div className="review-scope-divider" aria-hidden="true"><span>or</span></div>

      <section className="review-scope-section">
        <span className="review-scope-label">Compare</span>
        <span className="compare-inline-controls">
          <RefSearchPicker
            label="Base"
            repo={repo}
            worktree={worktree}
            selectedValue={baseRef}
            selectedLabel={baseLabel}
            fallbackResults={fallbackResults}
            trailingCommitOptions={showEmptyRepoOption && repoStartOption ? [repoStartOption] : []}
            portalPopover
            positionAnchorRef={menuRef}
            stayOutsideAnchor
            onOpenChange={onPickerOpenChange}
            onSelect={(option) => {
              setMode("compare");
              setBaseRef(option.value);
              setBaseLabel(option.label);
              setBaseIsRepoStart(option.value === repoStartOption?.value);
            }}
          />
          <span className="review-scope-arrow" aria-hidden="true">→</span>
          <RefSearchPicker
            label="Compare"
            repo={repo}
            worktree={worktree}
            selectedValue={compareRef}
            selectedLabel={compareLabel}
            fallbackResults={fallbackResults}
            refThreadCounts={refThreadCounts}
            portalPopover
            positionAnchorRef={menuRef}
            stayOutsideAnchor
            onOpenChange={onPickerOpenChange}
            onSelect={(option) => {
              setMode("compare");
              setCompareRef(option.value);
              setCompareLabel(option.label);
            }}
          />
        </span>
      </section>
    </div>
  );
}

function appliedScopeMode(
  target: string,
  presentation: ReviewTargetPresentation | undefined,
): ReviewScopeMode {
  if (presentation || parseCompareTarget(target)) return "compare";
  if (isBranchTarget(target)) return "branch";
  return "none";
}

function isBranchTarget(target: string): boolean {
  return target !== "staged" && target !== "unstaged" && !parseCompareTarget(target);
}

function branchRefForTarget(target: string, fallbackBase: string): string {
  return target === "work" || !isBranchTarget(target) ? fallbackBase || "HEAD" : target;
}

interface RefSearchPickerProps {
  label: string;
  repo: string;
  worktree: string | null;
  selectedValue: string;
  selectedLabel?: string;
  fallbackResults: RefSearchResults;
  allowedKinds?: RefSearchKind[];
  includeHead?: boolean;
  trailingCommitOptions?: RefSearchOption[];
  placeholder?: string;
  autoFocus?: boolean;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
  /** Render outside clipping and scrolling ancestors when true. */
  portalPopover: boolean;
  /** Optional larger surface to position against instead of the trigger itself. */
  positionAnchorRef?: RefObject<HTMLElement>;
  /** Place above or below the anchor without covering it. */
  stayOutsideAnchor?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelect: (option: RefSearchOption) => void;
}

function RefSearchPicker({
  label,
  repo,
  worktree,
  selectedValue,
  selectedLabel,
  fallbackResults,
  allowedKinds,
  includeHead = true,
  trailingCommitOptions = [],
  placeholder = "Find a branch, tag, or commit…",
  autoFocus = false,
  refThreadCounts,
  portalPopover,
  positionAnchorRef,
  stayOutsideAnchor = false,
  onOpenChange,
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RefSearchResults>(fallbackResults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const coords = usePopoverPosition(
    open,
    portalPopover,
    positionAnchorRef ?? rootRef,
    popoverRef,
    stayOutsideAnchor,
  );

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
        .searchRefs(repo, { query, limit: query ? 12 : 30, worktree })
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
        onOpenChange?.(false);
        if (!isFocusableClickTarget(node)) {
          window.requestAnimationFrame(() => triggerRef.current?.focus());
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onOpenChange, open]);

  const groups = useMemo(
    () => groupedOptions(results, query, allowedKinds, includeHead, trailingCommitOptions),
    [allowedKinds, includeHead, query, results, trailingCommitOptions],
  );
  const flat = groups.flatMap((group) => group.options);
  const hasResults = flat.length > 0;
  const branchOnly = allowedKinds?.every((kind) => kind === "branch" || kind === "remote") === true;

  const choose = (option: RefSearchOption) => {
    onSelect(option);
    setOpen(false);
    onOpenChange?.(false);
    setQuery("");
    // The selected option unmounts with the popover, so return focus to the
    // trigger for both inline and portaled layouts.
    triggerRef.current?.focus();
  };

  const popover = open ? (
    <span
      className="ref-popover"
      role="dialog"
      aria-labelledby={buttonId}
      ref={popoverRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          onOpenChange?.(false);
          triggerRef.current?.focus();
          return;
        }
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault();
          first.focus();
        }
      }}
      style={
        portalPopover
          ? {
              position: "fixed",
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              maxHeight: coords?.maxHeight,
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
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            onOpenChange?.(false);
            triggerRef.current?.focus();
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

      <span className="ref-results-meta" role="status" aria-live="polite" aria-atomic="true">
        {loading ? "Searching…" : error ? "Search failed" : branchOnly ? "Branches" : "Branches, tags, and commits"}
      </span>
      {error && <span className="ref-search-error" role="alert">{error}</span>}

      <ul id={listId} className="ref-results" role="listbox" aria-label={`${label} refs`}>
        {!loading && !error && !hasResults && (
          <li className="ref-empty">No {branchOnly ? "branches" : "refs or commits"} match “{query}”.</li>
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
        data-autofocus={autoFocus ? "" : undefined}
        type="button"
        className="selector ref-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          onOpenChange?.(nextOpen);
          setQuery("");
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
            onOpenChange?.(true);
          }
        }}
        title={`${label}: ${selectedLabel ?? displayRefValue(selectedValue)}`}
        aria-label={`${label}: ${selectedLabel ?? (displayRefValue(selectedValue) || `select ${label.toLowerCase()}`)}`}
      >
        {selectedLabel ?? (displayRefValue(selectedValue) || `Select ${label.toLowerCase()}`)}
      </button>

      {portalPopover && popover ? createPortal(popover, document.body) : popover}
    </span>
  );
}

function usePopoverPosition(
  open: boolean,
  portaled: boolean,
  anchorRef: RefObject<HTMLElement>,
  popoverRef: RefObject<HTMLElement>,
  stayOutsideAnchor = false,
) {
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    maxHeight?: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open || !portaled) return;
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const place = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const margin = 8;
      const popoverHeight = popover.offsetHeight;
      const popoverWidth = popover.offsetWidth;
      const gap = 6;
      let top = anchorRect.bottom + gap;
      let maxHeight: number | undefined;
      if (stayOutsideAnchor) {
        const belowHeight = window.innerHeight - top - margin;
        const aboveHeight = anchorRect.top - gap - margin;
        if (belowHeight >= 96 || belowHeight >= aboveHeight) {
          maxHeight = Math.max(0, belowHeight);
        } else {
          maxHeight = Math.max(0, aboveHeight);
          top = Math.max(margin, anchorRect.top - gap - maxHeight);
        }
      } else {
        if (
          popoverHeight > 0 &&
          top + popoverHeight > window.innerHeight - margin &&
          anchorRect.top - gap - popoverHeight > margin
        ) {
          top = anchorRect.top - gap - popoverHeight;
        }
        if (popoverHeight > 0) {
          top = Math.min(top, window.innerHeight - popoverHeight - margin);
        }
        top = Math.max(margin, top);
      }
      let left = anchorRect.left;
      if (popoverWidth > 0) {
        left = Math.min(left, window.innerWidth - popoverWidth - margin);
      }
      left = Math.max(margin, left);
      setCoords((previous) =>
        previous &&
        previous.top === top &&
        previous.left === left &&
        previous.maxHeight === maxHeight
          ? previous
          : { top, left, maxHeight },
      );
    };

    const scrollOptions = { passive: true, capture: true } as const;
    let layoutFrame = 0;
    const placeAfterLayout = () => {
      place();
      window.cancelAnimationFrame(layoutFrame);
      layoutFrame = window.requestAnimationFrame(place);
    };
    placeAfterLayout();
    window.addEventListener("scroll", place, scrollOptions);
    window.addEventListener("resize", placeAfterLayout);
    const observer = new ResizeObserver(placeAfterLayout);
    observer.observe(anchor);
    observer.observe(popover);
    const anchorMutationObserver = new MutationObserver(placeAfterLayout);
    anchorMutationObserver.observe(anchor, { attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      window.cancelAnimationFrame(layoutFrame);
      window.removeEventListener("scroll", place, scrollOptions);
      window.removeEventListener("resize", placeAfterLayout);
      anchorMutationObserver.disconnect();
      observer.disconnect();
      setCoords(null);
    };
  }, [anchorRef, open, popoverRef, portaled, stayOutsideAnchor]);

  return coords;
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

function groupedOptions(
  results: RefSearchResults,
  query: string,
  allowedKinds: RefSearchKind[] | undefined,
  includeHead: boolean,
  trailingCommitOptions: RefSearchOption[],
) {
  const needle = query.trim().toLowerCase();
  const allowed = (kind: RefSearchKind) => !allowedKinds || allowedKinds.includes(kind);
  const matches = (option: RefSearchOption) =>
    allowed(option.kind) &&
    (needle === "" ||
      option.label.toLowerCase().includes(needle) ||
      option.subject?.toLowerCase().includes(needle) === true);
  const head: RefSearchOption[] =
    includeHead && matches({ kind: "branch", value: "HEAD", label: "HEAD" })
      ? [{ kind: "branch", value: "HEAD", label: "HEAD", subject: "current checkout" }]
      : [];
  return [
    { title: "Branches", options: [...head, ...results.branches.filter(matches)] },
    { title: "Remote branches", options: results.remotes.filter(matches) },
    { title: "Tags", options: results.tags.filter(matches) },
    {
      title: "Commits",
      options: [...results.commits.filter(matches), ...trailingCommitOptions.filter(matches)],
    },
  ].filter((group) => group.options.length > 0);
}

function isFocusableClickTarget(node: Node): boolean {
  return (
    node instanceof Element &&
    node.closest(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ) !== null
  );
}

function parseCompareTarget(
  target: string,
): { base: string; compare: string; op: ".." | "..." } | null {
  const op = target.includes("...") ? "..." : target.includes("..") ? ".." : null;
  if (!op) return null;
  const [base, compare] = target.split(op);
  return base && compare ? { base, compare, op } : null;
}

function reviewTargetLabel(
  target: string,
  presentation: ReviewTargetPresentation | undefined,
  currentBranch: string | null,
  fallbackBase: string,
  repoStartOption: RefSearchOption | null,
): string {
  if (presentation) {
    const baseLabel = presentation.baseIsRepoStart ? EMPTY_REPO_LABEL : presentation.baseLabel;
    return `${baseLabel} → ${presentation.compareLabel}`;
  }
  const parsed = parseCompareTarget(target);
  if (parsed) {
    const baseLabel = parsed.base === repoStartOption?.value
      ? EMPTY_REPO_LABEL
      : displayRefValue(parsed.base);
    return `${baseLabel} → ${displayRefValue(parsed.compare)}`;
  }
  if (target !== "work" && target !== "staged" && target !== "unstaged") {
    return displayRefValue(target);
  }
  return fallbackBase || currentBranch || "Current checkout";
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
  if (/^[0-9a-f]{12,64}$/i.test(value)) return value.slice(0, 7);
  if (value.startsWith("tags/")) return value.slice("tags/".length);
  return value;
}
