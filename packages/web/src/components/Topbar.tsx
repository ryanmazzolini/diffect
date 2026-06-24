import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PullRequestLink,
  RefList,
  RepoSummary,
  WorkspaceEntry,
  WorkspaceInfo,
  WorktreeSummary,
} from "@diffect/shared";
import type { Theme } from "../theme.js";
import type { Density } from "../density.js";
import { Icon } from "../icons.js";
import diffectIconUrl from "../../../desktop/src-tauri/icons/icon.png";
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

function selectedWorktree(
  repo: RepoSummary | undefined,
  worktree: string | null,
): WorktreeSummary | null {
  if (!repo) return null;
  if (worktree) return repo.worktrees.find((w) => w.name === worktree) ?? null;
  return repo.worktrees.find((w) => w.root === repo.root) ?? repo.worktrees[0] ?? null;
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

interface WorkspaceNavProps {
  workspace: WorkspaceInfo;
  entries: WorkspaceEntry[];
  activeWorkspacePath: string;
  changedFilesByRepo: Map<string, number>;
  onSelectWorkspace: (path: string) => void;
  onAddWorkspace: () => void;
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
  workspaceRailOpen: boolean;
  onToggleWorkspaceRail: () => void;
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
  workspaceRailOpen,
  onToggleWorkspaceRail,
}: Props) {
  const activeRepo = workspace.repos.find((r) => r.name === repo);
  const activeWorktree = selectedWorktree(activeRepo, worktree);
  const hasFiles = filesChanged > 0;
  const multiRepo = workspace.repos.length > 1;

  return (
    <header className="rheader">
      <div className="rh-row rh-identity">
        <button
          type="button"
          className="icon-btn hamburger"
          onClick={onToggleWorkspaceRail}
          title="Toggle workspaces"
          aria-label="Toggle workspaces"
          aria-expanded={workspaceRailOpen}
          aria-controls="workspace-rail"
        >
          <Icon name="three-bars" />
        </button>
        <img className="brand" src={diffectIconUrl} alt="Diffect" />
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
      </div>

      <div className="rh-row rh-subbar">
        {/* N≥2: the per-repo base…compare picker lives in each module header and
            viewed progress is per-module, so the subbar
            drops both as redundant — only the global diff-display controls remain.
            N=1 keeps the picker + viewed count exactly as before; the single repo's
            review controls have nowhere else to live. */}
        {!multiRepo && (
          <>
            <RepoBranchMeta repo={repo} worktree={activeWorktree} />
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

function RepoBranchMeta({
  repo,
  worktree,
}: {
  repo: string;
  worktree: WorktreeSummary | null;
}) {
  const branch = worktree?.branch ?? "detached";
  return (
    <span className="repo-branch-meta" title={`${repo} · ${branch}`}>
      <span className="repo-branch-name">{repo}</span>
      <span className="repo-branch-sep">·</span>
      <Icon name="git-branch" size={12} />
      <span className="repo-branch-name">{branch}</span>
      <PullRequestBadge pullRequest={worktree?.pullRequest ?? null} />
    </span>
  );
}

export function PullRequestBadge({
  pullRequest,
}: {
  pullRequest: PullRequestLink | null;
}) {
  if (!pullRequest) return null;
  return (
    <a
      className="pr-link"
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer noopener"
      title={pullRequest.title ?? `PR #${pullRequest.number}`}
    >
      PR #{pullRequest.number}
    </a>
  );
}

function WorkspacePicker({
  workspace,
  entries,
  activeWorkspacePath,
  changedFilesByRepo,
  onSelectWorkspace,
  onAddWorkspace,
}: WorkspaceNavProps) {
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

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (!details || !details.open) return;
      if (event.target instanceof Node && !details.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

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

export function WorkspaceRail({
  workspace,
  entries,
  activeWorkspacePath,
  changedFilesByRepo,
  onSelectWorkspace,
  onAddWorkspace,
  onClose,
}: WorkspaceNavProps & { onClose: () => void }) {
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
    searchRef.current?.focus();
  }, []);

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

  const select = (path: string) => {
    const next = { ...recency, [path]: Date.now() };
    setRecency(next);
    setStored(WORKSPACE_RECENCY_KEY, JSON.stringify(next));
    onSelectWorkspace(path);
    onClose();
  };

  return (
    <aside id="workspace-rail" className="workspace-rail" aria-label="Workspaces">
      <div className="workspace-rail-head">
        <span className="workspace-rail-title">Workspaces</span>
        <button
          type="button"
          className="workspace-rail-close"
          onClick={onClose}
          title="Close workspaces"
          aria-label="Close workspaces"
        >
          <Icon name="x" size={13} />
        </button>
      </div>
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
          onClose();
          onAddWorkspace();
        }}
      >
        <Icon name="plus" size={13} />
        Add workspace
      </button>
    </aside>
  );
}
