import type { RefList, WorkspaceInfo } from "@diffect/shared";
import type { Theme } from "../theme.js";
import type { Density } from "../density.js";
import { Icon } from "../icons.js";
import { DiffStat } from "./DiffStat.js";
import { TargetPicker } from "./TargetPicker.js";

/** Trailing path segment of a workspace root, for the N≥2 crumb. */
function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

interface Props {
  workspace: WorkspaceInfo;
  repo: string;
  worktree: string | null;
  target: string;
  onTarget: (target: string) => void;
  refs: RefList | null;
  theme: Theme;
  onToggleTheme: () => void;
  density: Density;
  onDensity: (density: Density) => void;
  /** Side-by-side rendering when true, inline (unified) when false. */
  split: boolean;
  onToggleSplit: () => void;
  /** Wrap long lines when true; scroll horizontally when false. */
  wrap: boolean;
  onToggleWrap: () => void;
  additions: number;
  deletions: number;
  filesChanged: number;
  viewedCount: number;
  paneCollapsed: boolean;
  onTogglePane: () => void;
  onToggleSidebar: () => void;
}

/**
 * Application header, in two Linear-clean rows: an identity row (brand, workspace
 * path, total diffstat, theme/pane controls) and a subbar carrying the review
 * target picker, viewed progress, and the diff display controls (unified/split,
 * wrap, density). Repo/worktree selection lives in the sidebar.
 */
export function Topbar({
  workspace,
  repo,
  worktree,
  target,
  onTarget,
  refs,
  theme,
  onToggleTheme,
  density,
  onDensity,
  split,
  onToggleSplit,
  wrap,
  onToggleWrap,
  additions,
  deletions,
  filesChanged,
  viewedCount,
  paneCollapsed,
  onTogglePane,
  onToggleSidebar,
}: Props) {
  const activeRepo = workspace.repos.find((r) => r.name === repo);
  const hasFiles = filesChanged > 0;
  // N≥2 ⇒ a workspace holding several repos: show the workspace folder as a crumb
  // plus a repo count, so the header names the whole modules view. N=1 keeps the
  // bare repo path exactly as before — the single repo IS the workspace.
  const multiRepo = workspace.repos.length > 1;

  return (
    <header className="rheader">
      <div className="rh-row rh-identity">
        <button
          type="button"
          className="icon-btn hamburger"
          onClick={onToggleSidebar}
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
        >
          <Icon name="three-bars" />
        </button>
        <span className="brand" aria-hidden="true">
          d
        </span>
        {multiRepo ? (
          <>
            <span className="workspace-crumb" title={workspace.root}>
              {basename(workspace.root)}
            </span>
            <span className="repo-count">
              {workspace.repos.length} repos
            </span>
          </>
        ) : (
          <span className="workspace-path" title={workspace.root}>
            {workspace.root}
          </span>
        )}
        {hasFiles && <DiffStat additions={additions} deletions={deletions} />}

        <span className="rh-grow" />

        <button
          type="button"
          className="icon-btn theme-toggle"
          onClick={onToggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          aria-label="Toggle color theme"
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
        <button
          type="button"
          className="icon-btn pane-toggle"
          onClick={onTogglePane}
          title={paneCollapsed ? "Show threads panel" : "Hide threads panel"}
          aria-label="Toggle threads panel"
        >
          <Icon name={paneCollapsed ? "sidebar-expand" : "sidebar-collapse"} />
        </button>
      </div>

      <div className="rh-row rh-subbar">
        {/* N≥2: the per-repo base…compare picker lives in each module header and
            viewed progress is per-module (header) + the rail rollup, so the subbar
            drops both as redundant — only the global diff-display controls remain.
            N=1 keeps the picker + viewed count exactly as before; the single repo's
            review controls have nowhere else to live. */}
        {!multiRepo && (
          <>
            <TargetPicker
              repo={repo}
              worktree={worktree}
              defaultBranch={activeRepo?.defaultBranch ?? null}
              target={target}
              onTarget={onTarget}
              refs={refs}
            />
            {hasFiles && (
              <span className="metaitem" title="Files marked viewed">
                {viewedCount}/{filesChanged} viewed
              </span>
            )}
          </>
        )}

        <span className="rh-grow" />

        <div className="seg" role="group" aria-label="Diff view mode">
          <button
            type="button"
            className={!split ? "on" : ""}
            aria-pressed={!split}
            onClick={() => split && onToggleSplit()}
          >
            Unified
          </button>
          <button
            type="button"
            className={split ? "on" : ""}
            aria-pressed={split}
            onClick={() => !split && onToggleSplit()}
          >
            Split
          </button>
        </div>
        <button
          type="button"
          className="ghost wrap-toggle"
          aria-pressed={!wrap}
          title={
            wrap
              ? "Stop wrapping long lines (scroll horizontally)"
              : "Wrap long lines"
          }
          onClick={onToggleWrap}
        >
          {wrap ? "No wrap" : "Wrap"}
        </button>
        <div className="seg" role="group" aria-label="Density">
          <button
            type="button"
            className={density === "tight" ? "on" : ""}
            aria-pressed={density === "tight"}
            onClick={() => onDensity("tight")}
          >
            Tight
          </button>
          <button
            type="button"
            className={density === "compact" ? "on" : ""}
            aria-pressed={density === "compact"}
            onClick={() => onDensity("compact")}
          >
            Compact
          </button>
        </div>
      </div>
    </header>
  );
}
