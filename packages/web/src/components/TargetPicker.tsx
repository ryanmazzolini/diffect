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
import { defaultBranchRefNames } from "@diffect/shared";
import type {
  OpenReviewSummary,
  RefList,
  RefSearchKind,
  RefSearchOption,
  RefSearchPage,
  RefSearchResults,
  ReviewEndpointSummary,
  ReviewTargetPresentation,
} from "@diffect/shared";
import { api } from "../api.js";
import { relativeTime } from "../relativeTime.js";
import {
  createReviewSelectionIntentController,
  type ReviewSelectionIntentController,
} from "../reviewSelectionIntent.js";
import type {
  OpenReviewsState,
  ReviewRequestContext,
  ReviewRequestState,
  ReviewSelection,
} from "../reviewTarget.js";

const EMPTY_REPO_LABEL = "empty repo";
const BRANCH_PAGE_LIMIT = 5;
const COMMIT_PAGE_LIMIT = 10;
const LIVE_SELECTION_DEBOUNCE_MS = 150;
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
  const fallbackResults = useMemo(
    () => refsToSearchResults(refs, fallbackBase),
    [fallbackBase, refs],
  );
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
  const selectionIntentsRef = useRef<ReviewSelectionIntentController | null>(null);
  if (selectionIntentsRef.current === null) {
    selectionIntentsRef.current = createReviewSelectionIntentController(
      LIVE_SELECTION_DEBOUNCE_MS,
    );
  }
  const selectionIntents = selectionIntentsRef.current;
  const cancelDeferredSelection = useCallback(() => selectionIntents.cancel(), [selectionIntents]);
  const deferSelection = useCallback(
    (action: () => void) => selectionIntents.schedule(action),
    [selectionIntents],
  );
  const requestSelection = useCallback<Props["onSelection"]>(
    (selection, context) => selectionIntents.runNow(() => onSelection(selection, context)),
    [onSelection, selectionIntents],
  );
  useEffect(
    () => () => selectionIntents.cancel(),
    [repo, selectionIntents, worktree],
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
      void requestSelection(selection, { label });
    },
    [currentBranch, fallbackBase, repoStartOption, requestSelection, worktree],
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
        onSelection={requestSelection}
        onRefreshOpenReviews={onRefreshOpenReviews}
        onTarget={requestTarget}
        onDeferTarget={deferSelection}
        onCancelDeferredTarget={cancelDeferredSelection}
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
  onDeferTarget: (action: () => void) => void;
  onCancelDeferredTarget: () => void;
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
  onDeferTarget,
  onCancelDeferredTarget,
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
        onDeferTarget={onDeferTarget}
        onCancelDeferredTarget={onCancelDeferredTarget}
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
  currentBranch,
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
  onDeferTarget,
  onCancelDeferredTarget,
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
  onDeferTarget: (action: () => void) => void;
  onCancelDeferredTarget: () => void;
}) {
  const initialParsedTarget = presentation ? null : parseCompareTarget(target);
  const initialBranchRef = branchRefForTarget(target, fallbackBase);
  const optionCacheRef = useRef<Map<string, RefSearchOption>>(new Map());
  const draftTargetRef = useRef<string | null>(null);
  const draftAgainstRequestRef = useRef<ReviewRequestState | null>(null);
  const lastIssuedTargetRef = useRef<string | null>(null);
  cacheRefOptions(optionCacheRef.current, fallbackResults);
  if (repoStartOption) optionCacheRef.current.set(repoStartOption.value, repoStartOption);
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
    const nextBranch = branchRefForTarget(target, fallbackBase);
    setBranchRef(nextBranch);
    setBranchLabel(displayRefValue(nextBranch));
    setBaseRef(fallbackBase);
    setBaseLabel(displayRefValue(fallbackBase));
    setBaseIsRepoStart(false);
    setCompareRef("HEAD");
    setCompareLabel("HEAD");
  }, [fallbackBase, presentation, repoStartOption?.value, target]);

  useEffect(() => {
    if (
      draftTargetRef.current &&
      target === lastIssuedTargetRef.current &&
      target !== draftTargetRef.current
    ) {
      return;
    }
    if (target === draftTargetRef.current) {
      draftTargetRef.current = null;
      draftAgainstRequestRef.current = null;
    }
    syncControlsToLoaded();
  }, [syncControlsToLoaded, target]);
  useEffect(() => {
    if (reviewRequest?.status !== "error") return;
    draftTargetRef.current = null;
    draftAgainstRequestRef.current = null;
    lastIssuedTargetRef.current = null;
    onCancelDeferredTarget();
    syncControlsToLoaded();
  }, [onCancelDeferredTarget, reviewRequest?.status, syncControlsToLoaded]);

  useEffect(() => {
    if (
      draftTargetRef.current &&
      reviewRequest?.status === "loading" &&
      reviewRequest !== draftAgainstRequestRef.current &&
      reviewRequest.selection.target !== lastIssuedTargetRef.current
    ) {
      draftTargetRef.current = null;
      draftAgainstRequestRef.current = null;
      lastIssuedTargetRef.current = null;
      syncControlsToLoaded();
      return;
    }
    if (
      draftTargetRef.current &&
      reviewRequest === null &&
      target === draftTargetRef.current
    ) {
      draftTargetRef.current = null;
      draftAgainstRequestRef.current = null;
      syncControlsToLoaded();
    }
  }, [reviewRequest, syncControlsToLoaded, target]);
  useEffect(() => () => onCancelDeferredTarget(), [onCancelDeferredTarget]);

  const queueDraftTarget = (
    nextTarget: string,
    nextPresentation?: ReviewTargetPresentation,
  ) => {
    draftTargetRef.current = nextTarget;
    draftAgainstRequestRef.current = reviewRequest;
    const supersedesPending =
      reviewRequest?.status === "loading" &&
      reviewRequest.selection.target !== nextTarget;
    const matchesLoadedTarget =
      target === nextTarget &&
      (!nextPresentation || presentationsMatch(presentation, nextPresentation));
    if (matchesLoadedTarget && !supersedesPending) {
      draftTargetRef.current = null;
      draftAgainstRequestRef.current = null;
      onCancelDeferredTarget();
      return;
    }
    if (
      lastIssuedTargetRef.current === nextTarget &&
      reviewRequest?.status === "loading" &&
      reviewRequest.selection.target === nextTarget
    ) {
      onCancelDeferredTarget();
      return;
    }
    onDeferTarget(() => {
      lastIssuedTargetRef.current = nextTarget;
      onTarget(nextTarget, nextPresentation);
    });
  };

  const rememberOption = (option: RefSearchOption) => {
    optionCacheRef.current.set(option.value, option);
  };
  const branchOption = optionForValue(
    optionCacheRef.current,
    branchRef,
    fallbackResults,
    currentBranch,
  );
  const baseOption = optionForValue(
    optionCacheRef.current,
    baseRef,
    fallbackResults,
    currentBranch,
  );
  const compareOption = optionForValue(
    optionCacheRef.current,
    compareRef,
    fallbackResults,
    currentBranch,
  );
  const loadedDetails = manualReviewDetails(
    target,
    presentation,
    fallbackBase,
    optionCacheRef.current,
    fallbackResults,
    currentBranch,
  );

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
            selectedOption={branchOption}
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
              rememberOption(option);
              queueDraftTarget(option.value);
              setBranchRef(option.value);
              setBranchLabel(option.label);
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
            selectedOption={baseOption}
            fallbackResults={fallbackResults}
            trailingCommitOptions={showEmptyRepoOption && repoStartOption ? [repoStartOption] : []}
            portalPopover
            positionAnchorRef={menuRef}
            stayOutsideAnchor
            onOpenChange={onPickerOpenChange}
            onSelect={(option) => {
              rememberOption(option);
              const nextIsRepoStart = option.value === repoStartOption?.value;
              const nextTarget = compareTargetFor(
                option.value,
                compareRef,
                nextIsRepoStart,
                target,
              );
              queueDraftTarget(nextTarget, {
                kind: "compare",
                baseRef: option.value,
                baseLabel: option.label,
                ...(nextIsRepoStart ? { baseIsRepoStart: true } : {}),
                compareRef,
                compareLabel,
              });
              setBaseRef(option.value);
              setBaseLabel(option.label);
              setBaseIsRepoStart(nextIsRepoStart);
            }}
          />
          <span className="review-scope-arrow" aria-hidden="true">→</span>
          <RefSearchPicker
            label="Compare"
            repo={repo}
            worktree={worktree}
            selectedValue={compareRef}
            selectedLabel={compareLabel}
            selectedOption={compareOption}
            fallbackResults={fallbackResults}
            refThreadCounts={refThreadCounts}
            portalPopover
            positionAnchorRef={menuRef}
            stayOutsideAnchor
            onOpenChange={onPickerOpenChange}
            onSelect={(option) => {
              rememberOption(option);
              const nextTarget = compareTargetFor(
                baseRef,
                option.value,
                baseIsRepoStart,
                target,
              );
              queueDraftTarget(nextTarget, {
                kind: "compare",
                baseRef,
                baseLabel,
                ...(baseIsRepoStart ? { baseIsRepoStart: true } : {}),
                compareRef: option.value,
                compareLabel: option.label,
              });
              setCompareRef(option.value);
              setCompareLabel(option.label);
            }}
          />
        </span>
      </section>
      {loadedDetails && <ManualReviewDetails details={loadedDetails} />}
    </div>
  );
}

interface ManualReviewDetail {
  fromLabel: string;
  fromSha: string | null;
  toLabel: string;
  toSha: string | null;
  target: string;
}

function ManualReviewDetails({ details }: { details: ManualReviewDetail }) {
  const [copyStatus, setCopyStatus] = useState("");
  const copy = async () => {
    const text = [
      `From: ${details.fromSha ?? details.fromLabel}`,
      `To: ${details.toSha ?? details.toLabel}`,
      `Target: ${details.target}`,
    ].join("\n");
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(text);
      setCopyStatus("Comparison details copied");
    } catch {
      setCopyStatus("Could not copy comparison details");
    }
  };
  return (
    <details
      className="manual-review-details open-review-details"
      onToggle={() => setCopyStatus("")}
    >
      <summary>Comparison details</summary>
      <div className="open-review-details-body">
        <span><b>From</b> <code>{details.fromSha ?? details.fromLabel}</code></span>
        <span><b>To</b> <code>{details.toSha ?? details.toLabel}</code></span>
        <span><b>Target</b> <code>{details.target}</code></span>
        <button type="button" className="ghost mini" onClick={() => void copy()}>
          Copy details
        </button>
        <span className="open-review-copy-status" role="status" aria-live="polite">{copyStatus}</span>
      </div>
    </details>
  );
}

function manualReviewDetails(
  target: string,
  presentation: ReviewTargetPresentation | undefined,
  fallbackBase: string,
  cache: Map<string, RefSearchOption>,
  results: RefSearchResults,
  currentBranch: string | null,
): ManualReviewDetail | null {
  const parsed = presentation ? null : parseCompareTarget(target);
  if (presentation || parsed) {
    const baseRef = presentation?.baseRef ?? parsed?.base;
    const compareRef = presentation?.compareRef ?? parsed?.compare;
    if (!baseRef || !compareRef) return null;
    const from = optionForValue(cache, baseRef, results, currentBranch);
    const to = optionForValue(cache, compareRef, results, currentBranch);
    return {
      fromLabel: presentation?.baseIsRepoStart
        ? EMPTY_REPO_LABEL
        : presentation?.baseLabel ?? displayRefValue(baseRef),
      fromSha: fullShaFor(baseRef, from),
      toLabel: presentation?.compareLabel ?? displayRefValue(compareRef),
      toSha: fullShaFor(compareRef, to),
      target,
    };
  }
  if (!isBranchTarget(target)) return null;
  const branchRef = branchRefForTarget(target, fallbackBase);
  const from = optionForValue(cache, branchRef, results, currentBranch);
  return {
    fromLabel: displayRefValue(branchRef),
    fromSha: fullShaFor(branchRef, from),
    toLabel: "Working tree",
    toSha: null,
    target,
  };
}

function fullShaFor(value: string, option: RefSearchOption | null): string | null {
  if (option?.sha) return option.sha;
  return /^[0-9a-f]{12,64}$/i.test(value) ? value : null;
}

function compareTargetFor(
  baseRef: string,
  compareRef: string,
  baseIsRepoStart: boolean,
  loadedTarget: string,
): string {
  const parsed = parseCompareTarget(loadedTarget);
  const preservesTwoDotTarget =
    parsed?.op === ".." && parsed.base === baseRef && parsed.compare === compareRef;
  return `${baseRef}${baseIsRepoStart || preservesTwoDotTarget ? ".." : "..."}${compareRef}`;
}

function presentationsMatch(
  current: ReviewTargetPresentation | undefined,
  next: ReviewTargetPresentation,
): boolean {
  return Boolean(
    current &&
      current.baseRef === next.baseRef &&
      current.baseLabel === next.baseLabel &&
      current.baseIsRepoStart === next.baseIsRepoStart &&
      current.compareRef === next.compareRef &&
      current.compareLabel === next.compareLabel,
  );
}

function cacheRefOptions(cache: Map<string, RefSearchOption>, results: RefSearchResults) {
  for (const option of [
    ...results.branches,
    ...results.remotes,
    ...results.tags,
    ...results.commits,
  ]) {
    cache.set(option.value, option);
  }
}

function optionForValue(
  cache: Map<string, RefSearchOption>,
  value: string,
  results: RefSearchResults,
  currentBranch: string | null,
): RefSearchOption | null {
  const cached = cache.get(value);
  if (value === "HEAD") {
    const tip = currentBranch ? cache.get(currentBranch) : null;
    const recent = tip ?? results.commits[0] ?? null;
    if (cached?.sha || !recent) {
      return cached ?? { kind: "branch", value, label: "HEAD" };
    }
    const option: RefSearchOption = {
      kind: "branch",
      value,
      label: "HEAD",
      sha: recent.sha,
      shortSha: recent.shortSha,
      committer: recent.committer,
      committedAt: recent.committedAt,
      subject: recent.subject,
    };
    cache.set(value, option);
    return option;
  }
  if (cached) return cached;
  if (/^[0-9a-f]{12,64}$/i.test(value)) {
    const option: RefSearchOption = {
      kind: "commit",
      value,
      label: value.slice(0, 7),
      sha: value,
      shortSha: value.slice(0, 7),
    };
    cache.set(value, option);
    return option;
  }
  return null;
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
  selectedOption?: RefSearchOption | null;
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
  selectedOption = null,
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
  const [branchOffset, setBranchOffset] = useState(0);
  const [remoteOffset, setRemoteOffset] = useState(0);
  const [commitOffset, setCommitOffset] = useState(0);
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
    if (!open) {
      setResults(fallbackResults);
      setBranchOffset(0);
      setRemoteOffset(0);
      setCommitOffset(0);
    }
  }, [fallbackResults, open]);

  useEffect(() => {
    if (!open) return;
    const current = ++seq.current;
    setLoading(true);
    setError(null);
    const handle = window.setTimeout(() => {
      api
        .searchRefs(repo, {
          query,
          limit: query ? 12 : 30,
          branchOffset,
          branchLimit: BRANCH_PAGE_LIMIT,
          remoteOffset,
          remoteLimit: BRANCH_PAGE_LIMIT,
          commitOffset,
          commitLimit: COMMIT_PAGE_LIMIT,
          worktree,
        })
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
    return () => {
      window.clearTimeout(handle);
      if (seq.current === current) seq.current += 1;
    };
  }, [branchOffset, commitOffset, open, query, remoteOffset, repo, worktree]);

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
    () => groupedOptions(
      results,
      query,
      allowedKinds,
      includeHead,
      trailingCommitOptions,
      fallbackResults,
    ),
    [
      allowedKinds,
      fallbackResults,
      includeHead,
      query,
      results,
      trailingCommitOptions,
    ],
  );
  const flat = groups.flatMap((group) => group.options);
  const hasResults = flat.length > 0;
  const branchOnly = allowedKinds?.every((kind) => kind === "branch" || kind === "remote") === true;
  const showsCommits = !allowedKinds || allowedKinds.includes("commit");
  const showCommitPager = showsCommits &&
    (results.commitPage.hasNewer || results.commitPage.hasOlder);
  const commitRangeStart = results.commits.length > 0
    ? results.commitPage.offset + 1
    : results.commitPage.offset;
  const commitRangeEnd = results.commitPage.offset + results.commits.length;

  const setGroupOffset = (kind: "branch" | "remote", offset: number) => {
    if (kind === "branch") setBranchOffset(offset);
    else setRemoteOffset(offset);
    setActiveIndex(0);
  };

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
        const pagerButtons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ".ref-pagination button:not(:disabled)",
          ),
        );
        const target = event.target;
        if (target === inputRef.current && !event.shiftKey && pagerButtons.length > 0) {
          event.preventDefault();
          pagerButtons[0]?.focus();
          return;
        }
        const pagerIndex = pagerButtons.indexOf(target as HTMLButtonElement);
        if (pagerIndex >= 0 && event.shiftKey) {
          event.preventDefault();
          (pagerButtons[pagerIndex - 1] ?? inputRef.current)?.focus();
          return;
        }
        if (pagerIndex >= 0 && pagerIndex < pagerButtons.length - 1) {
          event.preventDefault();
          pagerButtons[pagerIndex + 1]?.focus();
          return;
        }
        event.preventDefault();
        setOpen(false);
        onOpenChange?.(false);
        focusAdjacentControl(triggerRef.current, event.shiftKey);
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
          setBranchOffset(0);
          setRemoteOffset(0);
          setCommitOffset(0);
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
                      tabIndex={-1}
                      aria-selected={selectedValue === option.value}
                      aria-label={refOptionAccessibleLabel(option, countLabel)}
                      title={refOptionTitle(option)}
                      className={`ref-option ${idx === activeIndex ? "active" : ""}`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => choose(option)}
                    >
                      <RefOptionContent option={option} />
                      <span className="ref-option-state">
                        {countLabel && (
                          <span
                            className={`ref-thread-count ${threadCount?.open ? "open" : "closed"}`}
                            title={refThreadCountTitle(threadCount!)}
                          >
                            {countLabel}
                          </span>
                        )}
                        {selectedValue === option.value && <span className="ref-check">✓</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {group.page && group.pageKind &&
              (group.page.hasNewer || group.page.hasOlder) && (
                <nav
                  className="ref-pagination ref-group-pagination"
                  aria-label={`${group.title} pages`}
                >
                  <button
                    type="button"
                    disabled={loading || !group.page.hasNewer}
                    onClick={() => setGroupOffset(
                      group.pageKind!,
                      Math.max(0, group.page!.offset - group.page!.limit),
                    )}
                  >
                    ← Newer
                  </button>
                  <span aria-live="polite" aria-atomic="true">
                    {group.title} {group.page.offset + 1}–
                    {group.page.offset + (group.resultCount ?? 0)}
                  </span>
                  <button
                    type="button"
                    disabled={loading || !group.page.hasOlder}
                    onClick={() => setGroupOffset(
                      group.pageKind!,
                      group.page!.offset + group.page!.limit,
                    )}
                  >
                    Older →
                  </button>
                </nav>
              )}
          </li>
        ))}
      </ul>
      {showCommitPager && (
        <nav className="ref-pagination" aria-label="Commit pages">
          <button
            type="button"
            disabled={loading || !results.commitPage.hasNewer}
            onClick={() => {
              setCommitOffset(Math.max(0, results.commitPage.offset - results.commitPage.limit));
              setActiveIndex(0);
            }}
          >
            ← Newer
          </button>
          <span aria-live="polite" aria-atomic="true">
            Commits {commitRangeStart}–{commitRangeEnd}
          </span>
          <button
            type="button"
            disabled={loading || !results.commitPage.hasOlder}
            onClick={() => {
              setCommitOffset(results.commitPage.offset + results.commitPage.limit);
              setActiveIndex(0);
            }}
          >
            Older →
          </button>
        </nav>
      )}
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
          setBranchOffset(0);
          setRemoteOffset(0);
          setCommitOffset(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
            setBranchOffset(0);
            setRemoteOffset(0);
            setCommitOffset(0);
            onOpenChange?.(true);
          }
        }}
        title={refTriggerTitle(label, selectedLabel, selectedValue, selectedOption)}
        aria-label={refTriggerAccessibleLabel(label, selectedLabel, selectedValue, selectedOption)}
      >
        {selectedOption ? (
          <RefOptionContent option={selectedOption} compact fallbackLabel={selectedLabel} />
        ) : (
          selectedLabel ?? (displayRefValue(selectedValue) || `Select ${label.toLowerCase()}`)
        )}
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

function refsToSearchResults(refs: RefList | null, priorityBranch: string): RefSearchResults {
  const commits = refs?.commits ?? [];
  const branches = refs?.branches ?? [];
  const remotes = refs?.remotes ?? [];
  const { local, remote } = defaultBranchRefNames(priorityBranch);
  return {
    query: "",
    branches: promoteRef(branches, local, []).slice(0, BRANCH_PAGE_LIMIT),
    branchPage: {
      offset: 0,
      limit: BRANCH_PAGE_LIMIT,
      hasNewer: false,
      hasOlder: branches.length > BRANCH_PAGE_LIMIT,
    },
    remotes: promoteRef(remotes, remote, []).slice(0, BRANCH_PAGE_LIMIT),
    remotePage: {
      offset: 0,
      limit: BRANCH_PAGE_LIMIT,
      hasNewer: false,
      hasOlder: remotes.length > BRANCH_PAGE_LIMIT,
    },
    tags: refs?.tags ?? [],
    commits: commits.slice(0, COMMIT_PAGE_LIMIT).map((commit) => ({
      kind: "commit",
      value: commit.sha,
      label: commit.shortSha,
      ...commit,
    })),
    commitPage: {
      offset: 0,
      limit: COMMIT_PAGE_LIMIT,
      hasNewer: false,
      hasOlder: commits.length > COMMIT_PAGE_LIMIT,
    },
  };
}

interface RefOptionGroup {
  title: string;
  options: RefSearchOption[];
  pageKind?: "branch" | "remote";
  page?: RefSearchPage;
  resultCount?: number;
}

function groupedOptions(
  results: RefSearchResults,
  query: string,
  allowedKinds: RefSearchKind[] | undefined,
  includeHead: boolean,
  trailingCommitOptions: RefSearchOption[],
  priorityFallbackResults: RefSearchResults,
) {
  const needle = query.trim().toLowerCase();
  const allowed = (kind: RefSearchKind) => !allowedKinds || allowedKinds.includes(kind);
  const matches = (option: RefSearchOption) =>
    allowed(option.kind) &&
    (needle === "" ||
      option.label.toLowerCase().includes(needle) ||
      (option.kind === "commit" &&
        option.subject?.toLowerCase().includes(needle) === true));
  const headTip = priorityFallbackResults.commits[0] ?? results.commits[0];
  const head: RefSearchOption[] =
    includeHead && matches({ kind: "branch", value: "HEAD", label: "HEAD" })
      ? [{
          kind: "branch",
          value: "HEAD",
          label: "HEAD",
          ...(headTip
            ? {
                sha: headTip.sha,
                shortSha: headTip.shortSha,
                committer: headTip.committer,
                committedAt: headTip.committedAt,
                subject: headTip.subject,
              }
            : { subject: "current checkout" }),
        }]
      : [];
  const branches = results.branches.filter(matches).slice(0, results.branchPage.limit);
  const remotes = results.remotes.filter(matches).slice(0, results.remotePage.limit);
  const commits = results.commits.filter(matches);
  const trailingCommits = trailingCommitOptions.filter(matches);
  const canShowTrailingCommits = needle !== "" ||
    (!results.commitPage.hasOlder && commits.length < results.commitPage.limit);
  const visibleTrailingCommits = canShowTrailingCommits
    ? trailingCommits.slice(0, Math.max(0, results.commitPage.limit - commits.length))
    : [];
  const groups: RefOptionGroup[] = [
    {
      title: "Branches",
      options: [...head, ...branches],
      pageKind: "branch",
      page: results.branchPage,
      resultCount: branches.length,
    },
    {
      title: "Remote branches",
      options: remotes,
      pageKind: "remote",
      page: results.remotePage,
      resultCount: remotes.length,
    },
    { title: "Tags", options: results.tags.filter(matches) },
    {
      title: "Commits",
      options: [...commits, ...visibleTrailingCommits],
    },
  ];
  return groups.filter((group) =>
    group.options.length > 0 || group.page?.hasNewer === true || group.page?.hasOlder === true
  );
}

function promoteRef(
  options: RefSearchOption[],
  value: string,
  fallbacks: RefSearchOption[],
): RefSearchOption[] {
  const index = options.findIndex((option) => option.value === value);
  if (index === 0) return options;
  const preferred = index > 0
    ? options[index]
    : fallbacks.find((option) => option.value === value);
  if (!preferred) return options;
  return [preferred, ...options.filter((option) => option.value !== value)];
}

function RefOptionContent({
  option,
  compact = false,
  fallbackLabel,
}: {
  option: RefSearchOption;
  compact?: boolean;
  fallbackLabel?: string;
}) {
  const primary = option.kind === "commit"
    ? option.shortSha ?? fallbackLabel ?? option.label
    : fallbackLabel ?? option.label;
  const time = option.committedAt ? relativeTime(option.committedAt) : "";
  const metadata = [
    option.kind === "commit" ? null : option.shortSha,
    option.committer,
    time,
  ].filter(Boolean).join(" · ");
  return (
    <span className={`ref-option-main${compact ? " compact" : ""}`} aria-hidden="true">
      <span className={option.kind === "commit" ? "ref-sha" : "ref-name"}>{primary}</span>
      {metadata && <span className="ref-meta">{metadata}</span>}
      {option.subject && <span className="ref-subject">{option.subject}</span>}
    </span>
  );
}

function refOptionAccessibleLabel(option: RefSearchOption, countLabel: string | null): string {
  const primary = option.kind === "commit"
    ? option.shortSha ?? option.label
    : option.label;
  return [
    primary,
    option.kind === "commit" ? null : option.shortSha ? `tip ${option.shortSha}` : null,
    option.committer,
    option.committedAt ? relativeTime(option.committedAt) : null,
    option.committedAt ? `committed ${exactTimestamp(option.committedAt)}` : null,
    option.subject,
    countLabel ? `${countLabel} comments` : null,
  ].filter(Boolean).join(", ");
}

function refOptionTitle(option: RefSearchOption): string | undefined {
  const details = [
    option.subject,
    option.sha,
    option.committedAt ? `committed ${exactTimestamp(option.committedAt)}` : null,
  ].filter(Boolean);
  return details.length > 0 ? details.join(" · ") : undefined;
}

function refTriggerAccessibleLabel(
  label: string,
  selectedLabel: string | undefined,
  selectedValue: string,
  option: RefSearchOption | null,
): string {
  const fallback =
    selectedLabel ?? (displayRefValue(selectedValue) || `select ${label.toLowerCase()}`);
  return option
    ? `${label}: ${refOptionAccessibleLabel({ ...option, label: selectedLabel ?? option.label }, null)}`
    : `${label}: ${fallback}`;
}

function refTriggerTitle(
  label: string,
  selectedLabel: string | undefined,
  selectedValue: string,
  option: RefSearchOption | null,
): string {
  const value = selectedLabel ?? displayRefValue(selectedValue);
  const details = option ? refOptionTitle(option) : undefined;
  return [`${label}: ${value}`, details].filter(Boolean).join(" · ");
}

function exactTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

function focusAdjacentControl(trigger: HTMLElement | null, backwards: boolean) {
  if (!trigger) return;
  const panel = trigger.closest<HTMLElement>(".review-target-popover");
  const selector = [
    "button:not(:disabled)",
    "input:not(:disabled)",
    "summary",
    '[tabindex]:not([tabindex="-1"])',
  ].join(", ");
  const controls = panel
    ? Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter(
        (control) => !control.closest(".ref-popover") && control.getClientRects().length > 0,
      )
    : [];
  const index = controls.indexOf(trigger);
  const adjacent = controls[index + (backwards ? -1 : 1)];
  if (adjacent) {
    adjacent.focus();
    return;
  }
  const panelTrigger = panel?.id
    ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(panel.id)}"]`)
    : null;
  if (backwards) {
    panelTrigger?.focus();
    return;
  }
  const pageControls = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
    (control) =>
      !control.closest(".review-target-popover") &&
      !control.closest(".ref-popover") &&
      control.getClientRects().length > 0,
  );
  const ownerIndex = panelTrigger ? pageControls.indexOf(panelTrigger) : -1;
  (pageControls[ownerIndex + 1] ?? panelTrigger)?.focus();
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
