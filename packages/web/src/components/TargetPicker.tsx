import {
  useCallback,
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
  OpenReviewSummary,
  RefList,
  RefSearchKind,
  RefSearchOption,
  RefSearchResults,
  ReviewEndpointSummary,
  ReviewTargetPresentation,
} from "@diffect/shared";
import { api } from "../api.js";
import { relativeTime } from "../relativeTime.js";
import type {
  OpenReviewsState,
  ReviewRequestContext,
  ReviewRequestState,
  ReviewSelection,
} from "../reviewTarget.js";

const EMPTY_REPO_LABEL = "empty repo";
const EMPTY_OPEN_REVIEWS_STATE: OpenReviewsState = { status: "loading", reviews: [] };

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
  presentation?: ReviewTargetPresentation;
  loadedSessionId: string | null;
  onSelection: (
    selection: ReviewSelection,
    context: ReviewRequestContext,
  ) => Promise<boolean>;
  refs: RefList | null;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
  openReviews?: OpenReviewsState;
  reviewRequest: ReviewRequestState | null;
  onRefreshOpenReviews: () => void;
}

/** A task-first review selector with staged/unstaged kept one click away. */
export function TargetPicker({
  repo,
  worktree,
  defaultBranch,
  currentBranch = null,
  target,
  presentation,
  loadedSessionId,
  onSelection,
  refs,
  refThreadCounts,
  openReviews = EMPTY_OPEN_REVIEWS_STATE,
  reviewRequest,
  onRefreshOpenReviews,
}: Props) {
  const fallbackBase = useMemo(
    () =>
      defaultBranch ??
      refs?.branches.find((branch) => branch.label === "main")?.value ??
      refs?.branches[0]?.value ??
      "",
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

  const requestTarget = useCallback(
    (nextTarget: string, nextPresentation?: ReviewTargetPresentation) => {
      const selection: ReviewSelection = {
        worktree,
        target: nextTarget,
        ...(nextPresentation ? { presentation: nextPresentation } : {}),
      };
      const label = reviewTargetLabel(
        nextTarget,
        nextPresentation,
        currentBranch,
        fallbackBase,
        repoStartOption,
      );
      void onSelection(selection, { label });
    },
    [currentBranch, fallbackBase, onSelection, repoStartOption, worktree],
  );

  return (
    <span className="target-picker">
      <ReviewTargetMenu
        repo={repo}
        worktree={worktree}
        currentBranch={currentBranch}
        target={target}
        presentation={presentation}
        loadedSessionId={loadedSessionId}
        fallbackBase={fallbackBase}
        fallbackResults={fallbackResults}
        repoStartOption={repoStartOption}
        showEmptyRepoOption={refs?.commitsReachRoot === true}
        refThreadCounts={refThreadCounts}
        openReviews={openReviews}
        reviewRequest={reviewRequest}
        onSelection={onSelection}
        onRefreshOpenReviews={onRefreshOpenReviews}
        onTarget={requestTarget}
      />
      {reviewRequest?.status === "loading" && (
        <span className="target-request-status" role="status" title={`Loading ${reviewRequest.context.label}`}>
          Loading {reviewRequest.context.label}…
        </span>
      )}
      <span className="local-targets" aria-label="Local review modes">
        {STATIC_LOCAL_TARGETS.map((mode) => (
          <button
            key={mode.target}
            type="button"
            className={`target-mode ${target === mode.target ? "active" : ""}`}
            onClick={() => requestTarget(mode.target)}
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

interface ReviewTargetMenuProps {
  repo: string;
  worktree: string | null;
  currentBranch: string | null;
  target: string;
  presentation?: ReviewTargetPresentation;
  loadedSessionId: string | null;
  fallbackBase: string;
  fallbackResults: RefSearchResults;
  repoStartOption: RefSearchOption | null;
  showEmptyRepoOption: boolean;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
  openReviews: OpenReviewsState;
  reviewRequest: ReviewRequestState | null;
  onSelection: (
    selection: ReviewSelection,
    context: ReviewRequestContext,
  ) => Promise<boolean>;
  onRefreshOpenReviews: () => void;
  onTarget: (target: string, presentation?: ReviewTargetPresentation) => void;
}

function ReviewTargetMenu({
  repo,
  worktree,
  currentBranch,
  target,
  presentation,
  loadedSessionId,
  fallbackBase,
  fallbackResults,
  repoStartOption,
  showEmptyRepoOption,
  refThreadCounts,
  openReviews,
  reviewRequest,
  onSelection,
  onRefreshOpenReviews,
  onTarget,
}: ReviewTargetMenuProps) {
  const headingId = useId();
  const panelId = useId();
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

  const requestOpenReview = async (review: OpenReviewSummary) => {
    const installed = await onSelection(reviewSelectionFor(review), {
      label: openReviewLabel(review),
      sessionId: review.sessionId,
    });
    if (installed) close(true);
  };

  const retryRequest = async () => {
    if (!reviewRequest) return;
    const installed = await onSelection(reviewRequest.selection, reviewRequest.context);
    if (installed && reviewRequest.context.sessionId) close(true);
  };

  const popover = open ? (
    <div
      id={panelId}
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
        if (event.key !== "Escape") return;
        event.preventDefault();
        close(true);
      }}
    >
      <header className="review-target-heading-row">
        <strong id={headingId} className="review-target-heading">Review changes</strong>
        <span className="review-target-current" title={triggerLabel}>{triggerLabel}</span>
      </header>
      <OpenReviewsTable
        state={openReviews}
        loadedSessionId={loadedSessionId}
        pendingSessionId={reviewRequest?.status === "loading" ? reviewRequest.context.sessionId : undefined}
        onRequest={requestOpenReview}
        onRefresh={onRefreshOpenReviews}
      />
      {reviewRequest && (
        <ReviewRequestNotice
          request={reviewRequest}
          onRetry={retryRequest}
          onRefresh={onRefreshOpenReviews}
        />
      )}
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
        reviewRequest={reviewRequest}
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
        aria-controls={open ? panelId : undefined}
        aria-label={`Loaded review: ${triggerLabel}`}
        title={triggerLabel}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span className="review-target-trigger-label">{triggerLabel}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {popover ? createPortal(popover, document.body) : null}
    </span>
  );
}

function OpenReviewsTable({
  state,
  loadedSessionId,
  pendingSessionId,
  onRequest,
  onRefresh,
}: {
  state: OpenReviewsState;
  loadedSessionId: string | null;
  pendingSessionId?: string;
  onRequest: (review: OpenReviewSummary) => Promise<void>;
  onRefresh: () => void;
}) {
  const headingId = useId();
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [blockedSessionId, setBlockedSessionId] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const reviews = state.reviews;

  useEffect(() => {
    const loadedIndex = reviews.findIndex((review) => review.sessionId === loadedSessionId);
    setActiveIndex((current) => {
      if (loadedIndex >= 0) return loadedIndex;
      return Math.min(current, Math.max(0, reviews.length - 1));
    });
  }, [loadedSessionId, reviews]);

  const activeReview = reviews[activeIndex] ?? null;
  const blockedReview = reviews.find((review) => review.sessionId === blockedSessionId) ?? null;
  const openCount = reviews.reduce((total, review) => total + review.openThreadCount, 0);

  const activate = (index: number) => {
    const nextIndex = Math.max(0, Math.min(reviews.length - 1, index));
    setActiveIndex(nextIndex);
    rowRefs.current[nextIndex]?.focus();
  };

  const choose = (review: OpenReviewSummary) => {
    const unavailable = unavailableReviewMessage(review);
    if (unavailable) {
      setBlockedSessionId(review.sessionId);
      return;
    }
    setBlockedSessionId(null);
    void onRequest(review);
  };

  const copyDetails = async (review: OpenReviewSummary) => {
    const text = reviewDetailsText(review);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(text);
      setCopyStatus("Review details copied");
    } catch {
      setCopyStatus("Could not copy review details");
    }
  };

  return (
    <section
      className="open-reviews-section"
      aria-labelledby={headingId}
      aria-busy={state.status === "loading" || undefined}
    >
      <div className="review-section-head">
        <strong id={headingId}>Open reviews</strong>
        <span>{reviews.length} scope{reviews.length === 1 ? "" : "s"} · {openCount} open</span>
      </div>

      {reviews.length > 0 ? (
        <div className="open-review-table-scroll">
          <table className="open-review-table" role="grid" aria-label="Open reviews">
            <colgroup>
              <col className="review-ref-col" />
              <col className="review-who-col" />
              <col className="review-subject-col" />
              <col className="review-ref-col" />
              <col className="review-who-col" />
              <col className="review-subject-col" />
              <col className="review-open-col" />
            </colgroup>
            <thead>
              <tr className="review-group-head">
                <th colSpan={3} scope="colgroup">From</th>
                <th colSpan={3} scope="colgroup" className="review-to-group">To</th>
                <th scope="col" rowSpan={2} className="review-open-head">Open</th>
              </tr>
              <tr className="review-column-head">
                <th scope="col">Ref</th>
                <th scope="col">Committer</th>
                <th scope="col">Subject</th>
                <th scope="col" className="review-to-ref">Ref</th>
                <th scope="col">Committer</th>
                <th scope="col">Subject</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((review, index) => {
                const unavailable = unavailableReviewMessage(review);
                const selected = review.sessionId === loadedSessionId;
                const pending = review.sessionId === pendingSessionId;
                return (
                  <tr
                    key={review.sessionId}
                    ref={(node) => { rowRefs.current[index] = node; }}
                    className={`open-review-row${selected ? " selected" : ""}${pending ? " pending" : ""}${unavailable ? " unavailable" : ""}`}
                    tabIndex={index === activeIndex ? 0 : -1}
                    data-autofocus={index === activeIndex ? "" : undefined}
                    aria-selected={selected}
                    aria-disabled={unavailable ? "true" : undefined}
                    aria-busy={pending || undefined}
                    aria-label={openReviewAccessibleLabel(review)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => choose(review)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        activate(index + 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        activate(index - 1);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        choose(review);
                      }
                    }}
                  >
                    <EndpointCells endpoint={review.from} />
                    <EndpointCells endpoint={review.to} to checkout={review.worktree} />
                    <td className="open-review-count">{pending ? "Loading…" : `${review.openThreadCount} open`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : state.status !== "error" ? (
        <div className="open-reviews-empty">
          {state.status === "loading" ? "Loading open reviews…" : "No reviews have open comments."}
        </div>
      ) : null}

      {state.status === "loading" && reviews.length > 0 && (
        <div className="open-reviews-status" role="status">Refreshing Open reviews…</div>
      )}
      {state.status === "error" && (
        <div className="open-reviews-error" role="alert">
          <span>Open reviews could not be refreshed. {state.message}</span>
          <button type="button" className="ghost mini" onClick={onRefresh}>Refresh</button>
        </div>
      )}
      {blockedReview && (
        <div className="open-reviews-error" role="alert">
          <span>{unavailableReviewMessage(blockedReview)}</span>
          <button type="button" className="ghost mini" onClick={onRefresh}>Refresh</button>
        </div>
      )}

      {activeReview && (
        <details className="open-review-details" onToggle={() => setCopyStatus("")}>
          <summary>Review details</summary>
          <div className="open-review-details-body">
            <span><b>From</b> <code>{activeReview.from.sha ?? activeReview.from.label}</code></span>
            <span><b>To</b> <code>{activeReview.to.sha ?? activeReview.to.label}</code></span>
            <span><b>Target</b> <code>{activeReview.scope.target}</code></span>
            <button type="button" className="ghost mini" onClick={() => void copyDetails(activeReview)}>
              Copy details
            </button>
            <span className="open-review-copy-status" role="status" aria-live="polite">{copyStatus}</span>
          </div>
        </details>
      )}
    </section>
  );
}

function EndpointCells({
  endpoint,
  to = false,
  checkout = null,
}: {
  endpoint: ReviewEndpointSummary;
  to?: boolean;
  checkout?: string | null;
}) {
  const displayRef = endpoint.kind === "commit"
    ? endpoint.shortSha ?? endpoint.label.slice(0, 7)
    : endpoint.label;
  const time = endpoint.committedAt ? relativeTime(endpoint.committedAt) : "";
  const byline = [endpoint.committer, time].filter(Boolean).join(" · ");
  return (
    <>
      <td className={`open-review-ref${to ? " review-to-ref" : ""}`} title={endpoint.label}>
        {displayRef}
      </td>
      <td className="open-review-who" title={endpoint.committedAt ?? undefined}>{byline}</td>
      <td
        className="open-review-subject"
        title={[endpoint.subject, checkout ? `${checkout} checkout` : null].filter(Boolean).join(" · ") || undefined}
      >
        {checkout && <span className="open-review-checkout">{checkout} · </span>}
        {endpoint.subject ?? "—"}
      </td>
    </>
  );
}

function ReviewRequestNotice({
  request,
  onRetry,
  onRefresh,
}: {
  request: ReviewRequestState;
  onRetry: () => Promise<void>;
  onRefresh: () => void;
}) {
  if (request.status === "loading") {
    return <div className="review-request-notice" role="status">Loading {request.context.label}…</div>;
  }
  return (
    <div className="review-request-notice error" role="alert">
      <span>Could not load {request.context.label}. {request.message}</span>
      <span className="review-request-actions">
        <button type="button" className="ghost mini" onClick={() => void onRetry()}>Retry</button>
        {request.context.sessionId && (
          <button type="button" className="ghost mini" onClick={onRefresh}>Refresh</button>
        )}
      </span>
    </div>
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
  reviewRequest,
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
  reviewRequest: ReviewRequestState | null;
  onTarget: (target: string, presentation?: ReviewTargetPresentation) => void;
}) {
  const initialParsedTarget = presentation ? null : parseCompareTarget(target);
  const initialBranchRef = branchRefForTarget(target, fallbackBase);
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

  const syncControlsToLoaded = useCallback(() => {
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

  useEffect(() => syncControlsToLoaded(), [syncControlsToLoaded]);
  useEffect(() => {
    if (reviewRequest?.status === "error") syncControlsToLoaded();
  }, [reviewRequest?.status, syncControlsToLoaded]);

  const requestCompare = (
    nextBaseRef: string,
    nextBaseLabel: string,
    nextBaseIsRepoStart: boolean,
    nextCompareRef: string,
    nextCompareLabel: string,
  ) => {
    const parsedTarget = parseCompareTarget(target);
    const preservesTwoDotTarget =
      parsedTarget?.op === ".." &&
      parsedTarget.base === nextBaseRef &&
      parsedTarget.compare === nextCompareRef;
    const operator = nextBaseIsRepoStart || preservesTwoDotTarget ? ".." : "...";
    onTarget(`${nextBaseRef}${operator}${nextCompareRef}`, {
      kind: "compare",
      baseRef: nextBaseRef,
      baseLabel: nextBaseLabel,
      ...(nextBaseIsRepoStart ? { baseIsRepoStart: true } : {}),
      compareRef: nextCompareRef,
      compareLabel: nextCompareLabel,
    });
  };

  return (
    <div className="review-scope-options">
      <div className="review-section-head">
        <strong>Choose comparison</strong>
        <span>Loads automatically</span>
      </div>
      <section className="review-scope-section">
        <div className="review-scope-title">
          <strong>Branch</strong>
          <span>Checkout</span>
        </div>
        <span className="compare-inline-controls branch-inline-controls">
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
              setBranchRef(option.value);
              setBranchLabel(option.label);
              onTarget(option.value);
            }}
          />
          <span className="review-scope-arrow" aria-hidden="true">→</span>
          <span className="review-local-endpoint">Working tree</span>
        </span>
      </section>

      <section className="review-scope-section">
        <div className="review-scope-title">
          <strong>Compare</strong>
          <span>Commits &amp; refs</span>
        </div>
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
              const nextIsRepoStart = option.value === repoStartOption?.value;
              setBaseRef(option.value);
              setBaseLabel(option.label);
              setBaseIsRepoStart(nextIsRepoStart);
              requestCompare(
                option.value,
                option.label,
                nextIsRepoStart,
                compareRef,
                compareLabel,
              );
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
              setCompareRef(option.value);
              setCompareLabel(option.label);
              requestCompare(baseRef, baseLabel, baseIsRepoStart, option.value, option.label);
            }}
          />
        </span>
      </section>
    </div>
  );
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
    branches: refs?.branches ?? [],
    remotes: refs?.remotes ?? [],
    tags: refs?.tags ?? [],
    commits: (refs?.commits ?? []).map((commit) => ({
      kind: "commit",
      value: commit.sha,
      label: commit.shortSha,
      ...commit,
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
      (option.kind === "commit" &&
        option.subject?.toLowerCase().includes(needle) === true));
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

function reviewSelectionFor(review: OpenReviewSummary): ReviewSelection {
  const presentation: ReviewTargetPresentation | undefined =
    review.scope.kind === "range"
      ? {
          kind: "compare",
          baseRef: review.scope.baseRef,
          baseLabel: review.from.label,
          compareRef: review.scope.headRef,
          compareLabel: review.to.label,
        }
      : undefined;
  return {
    worktree: review.worktree,
    target: review.scope.target,
    ...(presentation ? { presentation } : {}),
  };
}

function openReviewLabel(review: OpenReviewSummary): string {
  return `${endpointDisplayLabel(review.from)} → ${endpointDisplayLabel(review.to)}`;
}

function endpointDisplayLabel(endpoint: ReviewEndpointSummary): string {
  return endpoint.kind === "commit"
    ? endpoint.shortSha ?? endpoint.label.slice(0, 7)
    : endpoint.label;
}

function openReviewAccessibleLabel(review: OpenReviewSummary): string {
  const endpoint = (side: "From" | "To", summary: ReviewEndpointSummary) => {
    const parts = [
      `${side} ${endpointDisplayLabel(summary)}`,
      summary.committer,
      summary.committedAt,
      summary.subject,
    ].filter(Boolean);
    return parts.join(", ");
  };
  const checkout = review.worktree ? `${review.worktree} checkout` : "primary checkout";
  const availability = unavailableReviewMessage(review);
  return [
    endpoint("From", review.from),
    endpoint("To", review.to),
    checkout,
    `${review.openThreadCount} open comment${review.openThreadCount === 1 ? "" : "s"}`,
    availability,
  ].filter(Boolean).join("; ");
}

function unavailableReviewMessage(review: OpenReviewSummary): string | null {
  const availability = review.availability;
  if (availability.state === "available") return null;
  if (availability.state === "missing-checkout") {
    return `Checkout “${availability.worktree}” is no longer available.`;
  }
  if (availability.state === "missing-ref") {
    const endpoint = availability.endpoints.length === 2
      ? "From and To refs are"
      : `${availability.endpoints[0] === "from" ? "From" : "To"} ref is`;
    return `${endpoint} no longer available.`;
  }
  return "The persisted review scope no longer matches this checkout.";
}

function reviewDetailsText(review: OpenReviewSummary): string {
  return [
    `From: ${review.from.sha ?? review.from.label}`,
    `To: ${review.to.sha ?? review.to.label}`,
    `Target: ${review.scope.target}`,
    `Checkout: ${review.worktree ?? "primary"}`,
  ].join("\n");
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
  if (target === "staged") return "Staged changes";
  if (target === "unstaged") return "Unstaged changes";
  if (target !== "work") return displayRefValue(target);
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
