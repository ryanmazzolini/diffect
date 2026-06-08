import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile, RepoSummary, WorkspaceEntry } from "@diffect/shared";
import { Icon, type IconName } from "../icons.js";
import { getStored, setStored } from "../storage.js";
import {
  buildPathTree,
  type FileTreeEntry,
  type TreeFileStatus,
  type TreeNode,
} from "../fileTree.js";

interface Props {
  entries: WorkspaceEntry[];
  repo: string;
  worktree: string | null;
  onSelectRepo: (repo: string) => void;
  onSelectWorktree: (worktree: string | null) => void;
  files: DiffFile[];
  allFiles: string[];
  viewed: Set<string>;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onShowDiff: () => void;
  onAddWorkspace: () => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function diffFileEntries(files: DiffFile[]): FileTreeEntry[] {
  return files.map((file) => ({ path: file.path, status: file.status, file }));
}

function allFileEntries(paths: string[], changed: DiffFile[]): FileTreeEntry[] {
  const byPath = new Map<string, FileTreeEntry>();
  for (const path of paths) byPath.set(path, { path, status: "unchanged" });
  for (const file of changed) {
    byPath.set(file.path, { path: file.path, status: file.status, file });
  }
  return [...byPath.values()];
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
  allFiles,
  viewed,
  activeFile,
  onSelectFile,
  onShowDiff,
  onAddWorkspace,
}: Props) {
  const [fileMode, setFileMode] = useState<"diff" | "all">("diff");
  const treeEntries = useMemo(
    () => (fileMode === "all" ? allFileEntries(allFiles, files) : diffFileEntries(files)),
    [allFiles, fileMode, files],
  );
  const showFiles = files.length > 0 || allFiles.length > 0;

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

      {showFiles && (
        <>
          <div className="sidebar-head">
            <span>Files</span>
            {fileMode === "diff" && (
              <ReviewProgress
                files={files}
                viewed={viewed}
                activeFile={activeFile}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
          <div className="file-mode-toggle" role="group" aria-label="File list mode">
            <button
              type="button"
              className={`file-mode ${fileMode === "diff" ? "active" : ""}`}
              aria-pressed={fileMode === "diff"}
              onClick={() => {
                setFileMode("diff");
                onShowDiff();
              }}
            >
              Diff
            </button>
            <button
              type="button"
              className={`file-mode ${fileMode === "all" ? "active" : ""}`}
              aria-pressed={fileMode === "all"}
              onClick={() => setFileMode("all")}
            >
              All files
            </button>
          </div>
          {/* key remounts the tree on repo/mode switch so collapse state and
              the memoized tree re-initialize for the right file set. */}
          <FileTree
            key={`${repo}:${fileMode}`}
            repo={repo}
            entries={treeEntries}
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
  entries,
  activeFile,
  onSelectFile,
}: {
  repo: string;
  entries: FileTreeEntry[];
  activeFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  const tree = useMemo(() => buildPathTree(entries), [entries]);
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
          name={statusIcon(node.status)}
          size={12}
          className={`tree-icon status-${node.status}`}
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

function statusIcon(status: TreeFileStatus): IconName {
  switch (status) {
    case "added":
    case "untracked":
      return "diff-added" as const;
    case "deleted":
      return "diff-removed" as const;
    case "renamed":
      return "diff-renamed" as const;
    case "modified":
      return "diff-modified";
    case "unchanged":
      return "file";
    default:
      return "diff-modified";
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
