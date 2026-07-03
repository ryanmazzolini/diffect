import {
  memo,
  useCallback,
  useMemo,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  DiffFile,
  PullRequestLink,
  RefList,
  RepoDiff,
  ReviewSession,
  Thread,
} from "@diffect/shared";
import type { Theme } from "../theme.js";
import {
  LIFECYCLE_DOT,
  LIFECYCLE_LABEL,
  type Lifecycle,
} from "../lifecycle.js";
import { orderedDiffFiles } from "../fileTree.js";
import { CurrentSnapshotContext } from "../currentSnapshot.js";
import { Icon } from "../icons.js";
import { DiffView } from "./DiffView.js";
import { DiffStat } from "./DiffStat.js";
import { TargetPicker, type RefThreadCount } from "./TargetPicker.js";
import { PullRequestBadge } from "./Topbar.js";

// Stable empty reference so the memoized file derivation doesn't churn on the
// null-diff path.
const EMPTY_FILES: DiffFile[] = [];

interface Props {
  /** Non-stacked (N=1) layout only: the scrollable diff pane element — the
   * scroll-spy IntersectionObserver root and j/k scroll target, still owned by
   * App. In the stacked (N≥2) layout the shared `.modmain` owns that ref and each
   * module is a plain child, so this is omitted there. */
  paneRef?: RefObject<HTMLElement>;
  /** Stacked layout: render a sticky module header and sit inside the shared
   * scroll container. When false (the default) this is the literal single-pane
   * N=1 layout, byte-identical to the inline pane that predates the modules view. */
  stacked?: boolean;
  /** This module is the scroll-focused one (it drives the active repo); the
   * header takes an accent. Stacked layout only. */
  focused?: boolean;
  /** Per-module wayfinding band hue: 1 → --band-1, 2 → --band-2. Alternates down
   * the stack so two adjacent modules read as distinct. Stacked layout only. */
  band?: 1 | 2;
  repo: string;
  repoLabel?: string;
  worktree: string | null;
  branch?: string | null;
  pullRequest?: PullRequestLink | null;
  diff: RepoDiff | null;
  /** Threads already scoped to this module's repo + session by App. */
  threads: Thread[];
  viewed: Set<string>;
  split: boolean;
  wrap: boolean;
  theme: Theme;
  /** This module's review target plus the refs/defaultBranch backing its inline
   * base…compare picker. `onTarget` is repo-parameterized so a module retargets
   * only itself. */
  target?: string;
  refs?: RefList | null;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
  defaultBranch?: string | null;
  onTarget?: (repo: string, target: string) => void;
  /** This module's durable review state (the status crumb) plus the session its
   * Mark complete / Revive action archives or revives. `onArchive` is
   * repo-parameterized so a background module finishes its OWN review. */
  lifecycle?: Lifecycle;
  lifecycleSession?: ReviewSession | null;
  onArchive?: (repo: string, session: ReviewSession, archived: boolean) => void;
  /** Collapse is owned by App (so the repo rail can drive it too); this module is
   * controlled. Stacked layout only. */
  collapsed?: boolean;
  onToggleCollapse?: (repo: string) => void;
  /** Repo-parameterized so a module writes "viewed" to its own per-repo set even
   * if scroll-focus hasn't yet promoted it to the active repo. */
  onToggleViewed: (repo: string, path: string) => void;
  previewFile: string | null;
  onBackToDiff: () => void;
  onChanged: () => void;
  editors: string[];
  editor: string | null;
  onEditor: (editor: string) => void;
  onOpenFile: (repo: string, worktree: string | null, path: string, line?: number) => void;
}

/**
 * One repo's diff surface. At N=1 it's the single headerless diff pane, literally
 * the inline pane it replaced. At N≥2 it grows a sticky module header (collapse
 * caret, repo name, its own diffstat/viewed progress) and stacks with its siblings
 * inside one shared scroll container — the multi-repo "modules view".
 *
 * Each module provides its own `CurrentSnapshotContext` so the earlier-iteration
 * marker on inline threads compares against THIS repo's snapshot, not whichever
 * module happens to be focused. Memoized so App re-renders that don't touch this
 * module's inputs — notably scroll-focus ticks landing on a sibling — skip it.
 */
export const ModuleSection = memo(function ModuleSection({
  paneRef,
  stacked = false,
  focused = false,
  band = 1,
  repo,
  repoLabel = repo,
  worktree,
  branch = null,
  pullRequest = null,
  diff,
  threads,
  viewed,
  split,
  wrap,
  theme,
  target = "work",
  refs = null,
  refThreadCounts,
  defaultBranch = null,
  onTarget,
  lifecycle = "idle",
  lifecycleSession = null,
  onArchive,
  collapsed = false,
  onToggleCollapse,
  onToggleViewed,
  previewFile,
  onBackToDiff,
  onChanged,
  editors,
  editor,
  onEditor,
  onOpenFile,
}: Props) {
  // Files in display (tree) order, derived here so each stacked module owns its
  // own list without App looping hooks; stable per `diff` so the memoized DiffView
  // isn't churned when an unrelated sibling re-renders.
  const files = useMemo(() => orderedDiffFiles(diff?.files ?? EMPTY_FILES), [diff]);
  // Bind the viewed toggle to THIS module's repo. Stable across renders (repo is
  // constant per module, the factory is stable), so it doesn't defeat the memo.
  const handleToggleViewed = useCallback(
    (path: string) => onToggleViewed(repo, path),
    [onToggleViewed, repo],
  );
  // Bind the target change to THIS module's repo, mirroring handleToggleViewed —
  // stable across renders so it doesn't defeat the memo.
  const handleTarget = useCallback(
    (t: string) => onTarget?.(repo, t),
    [onTarget, repo],
  );
  // Bind the crumb's Mark complete / Revive to THIS module's repo + session, so a
  // background module finishes its own review without first becoming active.
  const handleArchive = useCallback(
    (archived: boolean) => {
      if (lifecycleSession) onArchive?.(repo, lifecycleSession, archived);
    },
    [onArchive, repo, lifecycleSession],
  );
  // Bind the collapse toggle to THIS module's repo, mirroring the others.
  const handleToggleCollapse = useCallback(
    () => onToggleCollapse?.(repo),
    [onToggleCollapse, repo],
  );

  const body = (
    <CurrentSnapshotContext.Provider value={diff?.currentSnapshotId ?? null}>
      <DiffView
        repo={repo}
        worktree={worktree}
        diff={diff}
        files={files}
        threads={threads}
        viewed={viewed}
        split={split}
        wrap={wrap}
        theme={theme}
        onToggleViewed={handleToggleViewed}
        previewFile={previewFile}
        onBackToDiff={onBackToDiff}
        onChanged={onChanged}
        editors={editors}
        editor={editor}
        onEditor={onEditor}
        onOpenFile={(path, line) => onOpenFile(repo, worktree, path, line)}
      />
    </CurrentSnapshotContext.Provider>
  );

  if (!stacked) {
    return (
      <section className="diff-pane" ref={paneRef}>
        <StackedModule
          repo={repo}
          repoLabel={repoLabel}
          band={band}
          focused={false}
          collapsible={false}
          files={files}
          viewed={viewed}
          worktree={worktree}
          branch={branch}
          pullRequest={pullRequest}
          target={target}
          refs={refs}
          refThreadCounts={refThreadCounts}
          defaultBranch={defaultBranch}
          onTarget={handleTarget}
          lifecycle={lifecycle}
          canArchive={false}
          onArchive={handleArchive}
          collapsed={false}
          onToggleCollapse={handleToggleCollapse}
        >
          {body}
        </StackedModule>
      </section>
    );
  }

  return (
    <StackedModule
      repo={repo}
      repoLabel={repoLabel}
      band={band}
      focused={focused}
      collapsible
      files={files}
      viewed={viewed}
      worktree={worktree}
      branch={branch}
      pullRequest={pullRequest}
      target={target}
      refs={refs}
      refThreadCounts={refThreadCounts}
      defaultBranch={defaultBranch}
      onTarget={handleTarget}
      lifecycle={lifecycle}
      canArchive={lifecycleSession !== null}
      onArchive={handleArchive}
      collapsed={collapsed}
      onToggleCollapse={handleToggleCollapse}
    >
      {body}
    </StackedModule>
  );
});

/** A repo module: line 1 names repo/branch/PR/status/stats, line 2 carries
 *  the base…compare picker. Multi-repo adds the band + collapse caret. */
function StackedModule({
  repo,
  repoLabel,
  band,
  focused,
  collapsible,
  files,
  viewed,
  worktree,
  branch,
  pullRequest,
  target,
  refs,
  refThreadCounts,
  defaultBranch,
  onTarget,
  lifecycle,
  canArchive,
  onArchive,
  collapsed,
  onToggleCollapse,
  children,
}: {
  repo: string;
  repoLabel: string;
  band: 1 | 2;
  focused: boolean;
  collapsible: boolean;
  files: DiffFile[];
  viewed: Set<string>;
  worktree: string | null;
  branch: string | null;
  pullRequest: PullRequestLink | null;
  target: string;
  refs: RefList | null;
  refThreadCounts?: ReadonlyMap<string, RefThreadCount>;
  defaultBranch: string | null;
  onTarget: (target: string) => void;
  lifecycle: Lifecycle;
  /** A settled session exists, so Mark complete / Revive can act. */
  canArchive: boolean;
  onArchive: (archived: boolean) => void;
  /** Collapse is controlled by App (so the rail can drive it too). */
  collapsed: boolean;
  onToggleCollapse: () => void;
  children: ReactNode;
}) {
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const filesChanged = files.length;
  const viewedCount = files.reduce((n, f) => (viewed.has(f.path) ? n + 1 : n), 0);
  const hasFiles = filesChanged > 0;

  return (
    <section
      className={`module ${collapsible ? `m${band}` : "single"}${focused ? " focused" : ""}${collapsed ? " collapsed" : ""}${!hasFiles ? " is-empty" : ""}`}
      data-repo={repo}
    >
      <header className="mod-head">
        <div className="mh-line1">
          {collapsible && <span className="mod-band" aria-hidden="true" />}
          {collapsible && (
            <button
              type="button"
              className="mh-caret"
              aria-expanded={!collapsed}
              aria-label={collapsed ? `Expand ${repoLabel}` : `Collapse ${repoLabel}`}
              title={collapsed ? "Expand this module" : "Collapse this module"}
              onClick={onToggleCollapse}
            >
              <Icon name="chevron-down" size={14} />
            </button>
          )}
          <span className="mh-repo">
            <span className="mh-repo-main">
              <span className="mod-name" title={repoLabel === repo ? undefined : repo}>{repoLabel}</span>
            </span>
            <span className="mh-branch" title={branch ? `Branch ${branch}` : "Detached HEAD"}>
              <Icon name="git-branch" size={12} className="fork" />
              {branch ?? "detached"}
            </span>
          </span>
          <PullRequestBadge pullRequest={pullRequest} />
          <span className="mh-state-wrap">
            <span
              className="status-crumb"
              title={`Review state: ${LIFECYCLE_LABEL[lifecycle]}`}
            >
              <span
                className={`sc-dot ${LIFECYCLE_DOT[lifecycle]}`}
                aria-hidden="true"
              />
              <span className="sc-label">{LIFECYCLE_LABEL[lifecycle]}</span>
              {canArchive && lifecycle === "ready" && (
                <button
                  type="button"
                  className="sc-ready-action"
                  onClick={() => onArchive(true)}
                >
                  Mark complete
                </button>
              )}
              {canArchive && lifecycle === "archived" && (
                <button
                  type="button"
                  className="sc-ready-action"
                  onClick={() => onArchive(false)}
                >
                  Revive
                </button>
              )}
            </span>
          </span>
          <span className="mh-stat">
            {hasFiles ? (
              <>
                <DiffStat additions={additions} deletions={deletions} />
                <span className="mh-files">
                  {filesChanged} file{filesChanged === 1 ? "" : "s"}
                </span>
                <span className="mh-viewed" title="Files marked viewed">
                  {viewedCount}/{filesChanged} viewed
                </span>
              </>
            ) : (
              <span className="mh-files mod-empty">No changes</span>
            )}
          </span>
        </div>
        <div className="mh-line2">
          <TargetPicker
            repo={repo}
            worktree={worktree}
            defaultBranch={defaultBranch}
            currentBranch={branch}
            target={target}
            onTarget={onTarget}
            refs={refs}
            refThreadCounts={refThreadCounts}
            // Repo headers live inside scroll panes, which clip inline popovers.
            portalPopover
          />
        </div>
      </header>
      {!collapsed && <div className="mod-body">{children}</div>}
    </section>
  );
}
