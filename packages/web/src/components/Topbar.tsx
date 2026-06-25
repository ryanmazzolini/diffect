import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type {
  PullRequestLink,
  WorkspaceEntry,
  WorkspaceInfo,
} from "@diffect/shared";
import type { Theme } from "../theme.js";
import type { Density } from "../density.js";
import { Icon } from "../icons.js";
import diffectIconUrl from "../../../desktop/src-tauri/icons/icon.png";
import { api } from "../api.js";
import { getStored, setStored } from "../storage.js";
import { DiffStat } from "./DiffStat.js";
import { OpenInMenu } from "./OpenInMenu.js";

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
  workspaceRailOpen: boolean;
  onToggleWorkspaceRail: () => void;
  editors: string[];
  editor: string | null;
  onEditor: (editor: string) => void;
  onOpenWorkspace: () => void;
  onOpenCurrentFile: () => void;
  canOpenCurrentFile: boolean;
}

/**
 * Application header: one compact row for workspace identity and global actions.
 * Infrequent view preferences live in the Options menu.
 */
export function Topbar({
  workspace,
  entries,
  activeWorkspacePath,
  changedFilesByRepo,
  onSelectWorkspace,
  onAddWorkspace,
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
  workspaceRailOpen,
  onToggleWorkspaceRail,
  editors,
  editor,
  onEditor,
  onOpenWorkspace,
  onOpenCurrentFile,
  canOpenCurrentFile,
}: Props) {
  const hasFiles = filesChanged > 0;
  const multiRepo = workspace.repos.length > 1;

  return (
    <header className="rheader">
      <div className="rh-row rh-identity" data-tauri-drag-region>
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

        <span className="rh-grow" data-tauri-drag-region />

        <OpenInMenu
          editors={editors}
          editor={editor}
          onEditor={onEditor}
          primaryAction={onOpenWorkspace}
          actions={[
            {
              label: "Open current file",
              onSelect: onOpenCurrentFile,
              disabled: !canOpenCurrentFile,
            },
          ]}
        />

        <button
          type="button"
          className="icon-btn theme-toggle"
          onClick={onToggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          aria-label="Toggle color theme"
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>

        <OptionsMenu
          density={density}
          onDensity={onDensity}
          split={split}
          onToggleSplit={onToggleSplit}
          wrap={wrap}
          onToggleWrap={onToggleWrap}
        />
      </div>
    </header>
  );
}

interface OptionsMenuProps {
  density: Density;
  onDensity: (density: Density) => void;
  split: boolean;
  onToggleSplit: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
}

function OptionsMenu({
  density,
  onDensity,
  split,
  onToggleSplit,
  wrap,
  onToggleWrap,
}: OptionsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const chooseSplit = (next: boolean) => {
    if (split !== next) onToggleSplit();
    close();
  };
  const chooseDensity = (next: Density) => {
    if (density !== next) onDensity(next);
    close();
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!open) return;
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      className="options-menu"
      ref={menuRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <button
        type="button"
        className="options-trigger"
        title="View options"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Options</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="open-in-popover options-popover">
          <div className="open-in-label">Diff view</div>
          <div role="group" aria-label="Diff view mode">
            <OptionsItem active={!split} onSelect={() => chooseSplit(false)}>
              Unified
            </OptionsItem>
            <OptionsItem active={split} onSelect={() => chooseSplit(true)}>
              Split
            </OptionsItem>
          </div>
          <div className="open-in-divider" />
          <OptionsItem
            active={!wrap}
            onSelect={() => {
              onToggleWrap();
              close();
            }}
          >
            No wrap
          </OptionsItem>
          <div className="open-in-divider" />
          <div className="open-in-label">Density</div>
          <div role="group" aria-label="Density">
            <OptionsItem
              active={density === "tight"}
              onSelect={() => chooseDensity("tight")}
            >
              Tight
            </OptionsItem>
            <OptionsItem
              active={density === "compact"}
              onSelect={() => chooseDensity("compact")}
            >
              Compact
            </OptionsItem>
          </div>
        </div>
      )}
    </div>
  );
}

function OptionsItem({
  active,
  onSelect,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className={`open-in-item options-item ${active ? "active" : ""}`}
      aria-pressed={active}
      onClick={onSelect}
    >
      {active ? <Icon name="check" size={13} className="options-check" /> : <span />}
      <span>{children}</span>
    </button>
  );
}

export function PullRequestBadge({
  pullRequest,
}: {
  pullRequest: PullRequestLink | null;
}) {
  if (!pullRequest) return null;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void api
      .openUrl({ url: pullRequest.url })
      .catch(() => window.location.assign(pullRequest.url));
  };
  return (
    <a
      className="pr-link"
      href={pullRequest.url}
      onClick={open}
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
