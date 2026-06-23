import { useEffect, useMemo, useRef, useState } from "react";
import type { RefList, WorkspaceEntry, WorkspaceInfo } from "@diffect/shared";
import type { Theme } from "../theme.js";
import type { Density } from "../density.js";
import { Icon } from "../icons.js";
import { getStored, setStored } from "../storage.js";
import { DiffStat } from "./DiffStat.js";
import { TargetPicker } from "./TargetPicker.js";

const WORKSPACE_RECENCY_KEY = "diffect-workspace-recency";

/** Trailing path segment of a workspace root. */
function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function loadWorkspaceRecency(): Record<string, number> {
  const raw = getStored(WORKSPACE_RECENCY_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [path, value] of Object.entries(parsed)) {
      if (typeof value === "number") out[path] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function workspaceMeta(
  workspace: WorkspaceEntry,
  changedFilesByRepo: Map<string, number>,
): string {
  const loaded = workspace.repos.some((r) => changedFilesByRepo.has(r.name));
  const changed = workspace.repos.reduce(
    (n, r) => n + (changedFilesByRepo.get(r.name) ?? 0),
    0,
  );
  const repoCount = `${workspace.repos.length} repo${workspace.repos.length === 1 ? "" : "s"}`;
  if (!loaded) return repoCount;
  return `${repoCount} · ${changed} changed file${changed === 1 ? "" : "s"}`;
}

interface Props {
  workspace: WorkspaceInfo;
  entries: WorkspaceEntry[];
  activeWorkspacePath: string;
  changedFilesByRepo: Map<string, number>;
  onSelectWorkspace: (path: string) => void;
  onAddWorkspace: () => void;
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
 * Application header, in two Linear-clean rows: identity/search on top, review
 * controls below. Workspace switching lives beside the path where users already
 * look for location.
 */
export function Topbar({
  workspace,
  entries,
  activeWorkspacePath,
  changedFilesByRepo,
  onSelectWorkspace,
  onAddWorkspace,
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
        <span className="brand" role="img" aria-label="Diffect">
          <span className="brand-bar brand-add" />
          <span className="brand-bar brand-del" />
        </span>
        <WorkspacePicker
          workspace={workspace}
          entries={entries}
          activeWorkspacePath={activeWorkspacePath}
          changedFilesByRepo={changedFilesByRepo}
          onSelectWorkspace={onSelectWorkspace}
          onAddWorkspace={onAddWorkspace}
        />
        <span className="workspace-path" title={workspace.root}>
          {workspace.root}
        </span>
        {multiRepo && (
          <span className="repo-count">
            {workspace.repos.length} repos
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
            viewed progress is per-module, so the subbar
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

function WorkspacePicker({
  workspace,
  entries,
  activeWorkspacePath,
  changedFilesByRepo,
  onSelectWorkspace,
  onAddWorkspace,
}: {
  workspace: WorkspaceInfo;
  entries: WorkspaceEntry[];
  activeWorkspacePath: string;
  changedFilesByRepo: Map<string, number>;
  onSelectWorkspace: (path: string) => void;
  onAddWorkspace: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [recency, setRecency] = useState(loadWorkspaceRecency);
  const fallbackEntry = useMemo<WorkspaceEntry>(
    () => ({ path: workspace.root, repos: workspace.repos }),
    [workspace.repos, workspace.root],
  );
  const allEntries = entries.length > 0 ? entries : [fallbackEntry];
  const active =
    allEntries.find((entry) => entry.path === activeWorkspacePath) ?? fallbackEntry;

  useEffect(() => {
    setRecency((prev) => {
      const next = { ...prev, [activeWorkspacePath]: Date.now() };
      setStored(WORKSPACE_RECENCY_KEY, JSON.stringify(next));
      return next;
    });
  }, [activeWorkspacePath]);

  const sorted = useMemo(() => {
    const originalOrder = new Map(allEntries.map((entry, index) => [entry.path, index]));
    return [...allEntries].sort(
      (a, b) =>
        (recency[b.path] ?? 0) - (recency[a.path] ?? 0) ||
        (originalOrder.get(a.path) ?? 0) - (originalOrder.get(b.path) ?? 0),
    );
  }, [allEntries, recency]);
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? sorted.filter((entry) =>
        `${basename(entry.path)} ${entry.path}`.toLowerCase().includes(needle),
      )
    : sorted;

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };
  const select = (path: string) => {
    const next = { ...recency, [path]: Date.now() };
    setRecency(next);
    setStored(WORKSPACE_RECENCY_KEY, JSON.stringify(next));
    onSelectWorkspace(path);
    setQuery("");
    close();
  };

  return (
    <details
      className="workspace-picker"
      ref={detailsRef}
      onToggle={() => {
        if (detailsRef.current?.open) requestAnimationFrame(() => searchRef.current?.focus());
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <summary className="workspace-trigger" title={active.path}>
        <span className="workspace-trigger-name">{basename(active.path)}</span>
        <Icon name="chevron-down" size={12} />
      </summary>
      <div className="workspace-menu">
        <label className="workspace-search">
          <Icon name="search" size={13} />
          <input
            ref={searchRef}
            aria-label="Search workspaces"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search workspaces…"
          />
        </label>
        <div className="workspace-options">
          {filtered.length === 0 ? (
            <div className="workspace-empty">No workspaces found</div>
          ) : (
            filtered.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className={`workspace-option ${entry.path === active.path ? "active" : ""}`}
                onClick={() => select(entry.path)}
              >
                <span className="workspace-option-name">{basename(entry.path)}</span>
                <span className="workspace-option-meta">
                  {workspaceMeta(entry, changedFilesByRepo)}
                </span>
                <span className="workspace-option-path">{entry.path}</span>
              </button>
            ))
          )}
        </div>
        <button
          type="button"
          className="workspace-add"
          onClick={() => {
            close();
            onAddWorkspace();
          }}
        >
          <Icon name="plus" size={13} />
          Add workspace
        </button>
      </div>
    </details>
  );
}
