import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile, FileStatus, RepoSummary, WorkspaceEntry } from "@diffect/shared";
import { Icon } from "../icons.js";
import { getStored, setStored } from "../storage.js";
import { buildFileTree, type TreeNode } from "../fileTree.js";

interface Props {
  entries: WorkspaceEntry[];
  repo: string;
  worktree: string | null;
  onSelectRepo: (repo: string) => void;
  onSelectWorktree: (worktree: string | null) => void;
  files: DiffFile[];
  viewed: Set<string>;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onAddWorkspace: () => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Left navigation: workspaces → repos → worktrees, plus the changed-file tree.
 * Memoized so a diff/thread change doesn't re-render the whole nav. */
export const Sidebar = memo(function Sidebar({
  entries,
  repo,
  worktree,
  onSelectRepo,
  onSelectWorktree,
  files,
  viewed,
  activeFile,
  onSelectFile,
  onAddWorkspace,
}: Props) {
  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <span>Workspaces</span>
        <button
          type="button"
          className="icon-btn sidebar-add"
          title="Add a workspace"
          aria-label="Add a workspace"
          onClick={onAddWorkspace}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {entries.map((ws) => (
        <div className="ws-group" key={ws.path}>
          {/* A single-repo workspace's folder name just duplicates the repo row,
              so only label the group when it actually holds multiple repos. */}
          {ws.repos.length > 1 && (
            <div className="ws-path" title={ws.path}>
              {basename(ws.path)}
            </div>
          )}
          {ws.repos.map((r) => (
            <RepoItem
              key={r.name}
              repo={r}
              active={r.name === repo}
              worktree={worktree}
              onSelectRepo={onSelectRepo}
              onSelectWorktree={onSelectWorktree}
            />
          ))}
        </div>
      ))}

      {files.length > 0 && (
        <>
          <div className="sidebar-head">
            <span>Files</span>
            <ReviewProgress
              files={files}
              viewed={viewed}
              activeFile={activeFile}
              onSelectFile={onSelectFile}
            />
          </div>
          {/* key={repo} remounts the tree on repo switch so collapse state and
              the memoized tree re-initialize from the right repo. */}
          <FileTree
            key={repo}
            repo={repo}
            files={files}
            activeFile={activeFile}
            onSelectFile={onSelectFile}
          />
        </>
      )}
    </nav>
  );
});

/**
 * Review progress for the changed files: a clickable bar that jumps to the next
 * unviewed file (wrapping past the active one). It lives beside the file list so
 * the count reads in context, not as a stray number in the header.
 */
function ReviewProgress({
  files,
  viewed,
  activeFile,
  onSelectFile,
}: {
  files: DiffFile[];
  viewed: Set<string>;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  const total = files.length;
  const done = files.reduce((n, f) => (viewed.has(f.path) ? n + 1 : n), 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const allViewed = done >= total;

  const jumpNextUnviewed = () => {
    const start = activeFile ? files.findIndex((f) => f.path === activeFile) : -1;
    for (let i = 1; i <= total; i++) {
      const f = files[(start + i + total) % total]!;
      if (!viewed.has(f.path)) return onSelectFile(f.path);
    }
  };

  return (
    <button
      type="button"
      className="review-progress"
      onClick={jumpNextUnviewed}
      disabled={allViewed}
      title={allViewed ? "All files viewed" : "Jump to the next unviewed file"}
      aria-label={`${done} of ${total} files viewed${allViewed ? "" : ", jump to next unviewed"}`}
    >
      <span className="review-progress-bar" aria-hidden="true">
        <span className="review-progress-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="review-progress-count">
        {done}/{total}
      </span>
    </button>
  );
}

const collapsedKey = (repo: string) => `diffect-tree-collapsed:${repo}`;

function loadCollapsed(repo: string): Set<string> {
  try {
    const raw = getStored(collapsedKey(repo));
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Collapsible changed-file tree, expansion state persisted per repo. */
function FileTree({
  repo,
  files,
  activeFile,
  onSelectFile,
}: {
  repo: string;
  files: DiffFile[];
  activeFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(repo));
  // Keep the scroll-spy-highlighted file visible without yanking the whole list:
  // `nearest` only scrolls the sidebar the minimum needed.
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeFile) return;
    treeRef.current
      ?.querySelector(".tree-file.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeFile]);

  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      setStored(collapsedKey(repo), JSON.stringify([...next]));
      return next;
    });

  return (
    <div className="file-tree" role="tree" ref={treeRef}>
      {tree.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          collapsed={collapsed}
          onToggleDir={toggleDir}
          activeFile={activeFile}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  collapsed,
  onToggleDir,
  activeFile,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggleDir: (path: string) => void;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  // Indent by depth; pad files an extra step so they align past a folder chevron.
  const indent = (depth: number, isFile: boolean) =>
    ({ paddingLeft: `${depth * 12 + (isFile ? 18 : 4)}px` }) as const;

  if (node.type === "file") {
    return (
      <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        className={`tree-file ${node.path === activeFile ? "active" : ""}`}
        style={indent(depth, true)}
        title={node.path}
        onClick={() => onSelectFile(node.path)}
      >
        <Icon
          name={statusIcon(node.file.status)}
          size={12}
          className={`tree-icon status-${node.file.status}`}
        />
        <span className="tree-name">{node.name}</span>
      </button>
    );
  }

  const isCollapsed = collapsed.has(node.path);
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={!isCollapsed}
        className="tree-dir"
        style={indent(depth, false)}
        onClick={() => onToggleDir(node.path)}
      >
        <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={12} />
        <span className="tree-name">{node.name}</span>
      </button>
      {!isCollapsed &&
        node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            collapsed={collapsed}
            onToggleDir={onToggleDir}
            activeFile={activeFile}
            onSelectFile={onSelectFile}
          />
        ))}
    </>
  );
}

function statusIcon(status: FileStatus) {
  switch (status) {
    case "added":
    case "untracked":
      return "diff-added" as const;
    case "deleted":
      return "diff-removed" as const;
    case "renamed":
      return "diff-renamed" as const;
    default:
      return "diff-modified" as const;
  }
}

function RepoItem({
  repo,
  active,
  worktree,
  onSelectRepo,
  onSelectWorktree,
}: {
  repo: RepoSummary;
  active: boolean;
  worktree: string | null;
  onSelectRepo: (repo: string) => void;
  onSelectWorktree: (worktree: string | null) => void;
}) {
  return (
    <div>
      <button
        type="button"
        className={`repo-item ${active ? "active" : ""}`}
        onClick={() => onSelectRepo(repo.name)}
      >
        {repo.name}
      </button>
      {active && repo.worktrees.length > 1 && (
        <div className="worktree-list">
          <WorktreeItem
            name="all worktrees"
            active={worktree === null}
            onClick={() => onSelectWorktree(null)}
          />
          {repo.worktrees.map((w) => (
            <WorktreeItem
              key={w.name}
              name={w.name}
              active={worktree === w.name}
              onClick={() => onSelectWorktree(w.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorktreeItem({
  name,
  active,
  onClick,
}: {
  name: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`wt-item ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {name}
    </button>
  );
}
