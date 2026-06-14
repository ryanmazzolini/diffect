import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  DiffFile,
  RepoSummary,
  ReviewScope,
  ReviewSession,
  WorkspaceEntry,
} from "@diffect/shared";
import { Icon, type IconName } from "../icons.js";
import { getStored, setStored } from "../storage.js";
import {
  buildPathTree,
  type FileTreeEntry,
  type TreeFile,
  type TreeFileStatus,
  type TreeNode,
} from "../fileTree.js";

interface Props {
  entries: WorkspaceEntry[];
  repo: string;
  /** Id of the session the active diff resolved to — drives the entry highlight. */
  currentSession: string | null;
  /** The unscoped/legacy bucket is open; no session entry is highlighted. */
  showUnscoped: boolean;
  /** Sessions reachable beyond the server-derived set (reconstructed/ad-hoc). */
  extraSessions: ReviewSession[];
  /** Thread count per session id, plus the legacy bucket under `__legacy__`. */
  sessionCounts: Map<string, number>;
  /** Pre-scope thread count; the unscoped bucket renders only when > 0. */
  legacyCount: number;
  onSelectRepo: (repo: string) => void;
  onSelectSession: (session: ReviewSession) => void;
  onSelectLegacy: () => void;
  files: DiffFile[];
  allFiles: string[];
  viewed: Set<string>;
  /** Open-thread count per file path, for the tree/list badges. */
  threadCounts: Map<string, number>;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onShowDiff: () => void;
  onAddWorkspace: () => void;
}

const LEGACY_KEY = "__legacy__";
const EMPTY_SESSIONS: ReviewSession[] = [];

/**
 * Human label for a review session, derived from its scope so the client never
 * duplicates the server's ref-resolution. Work on a feature branch reads as the
 * branch; on the default branch it's local-state work (base === head); ranges
 * and refs read as `base..head`; index/worktree scopes name themselves.
 */
function sessionLabel(scope: ReviewScope): string {
  switch (scope.kind) {
    case "work":
      if (scope.branch) {
        return scope.baseRef === scope.headRef
          ? `${scope.branch} (local)`
          : scope.branch;
      }
      return `${scope.headRef.replace(/^wt:/, "")} (detached)`;
    case "staged":
      return "Staged changes";
    case "unstaged":
      return "Unstaged changes";
    case "ref":
    case "range":
      return `${scope.baseRef}..${scope.headRef}`;
  }
}

/** Secondary muted line: a work session's PR-like base, else nothing. */
function sessionDetail(scope: ReviewScope): string | null {
  if (scope.kind === "work" && scope.branch && scope.baseRef !== scope.headRef) {
    return `vs ${scope.baseRef}`;
  }
  return null;
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

/** Left navigation: workspaces → repos → review sessions, plus the changed-file
 * tree. Memoized so a diff/thread change doesn't re-render the whole nav. */
export const Sidebar = memo(function Sidebar({
  entries,
  repo,
  currentSession,
  showUnscoped,
  extraSessions,
  sessionCounts,
  legacyCount,
  onSelectRepo,
  onSelectSession,
  onSelectLegacy,
  files,
  allFiles,
  viewed,
  threadCounts,
  activeFile,
  onSelectFile,
  onShowDiff,
  onAddWorkspace,
}: Props) {
  const [fileMode, setFileMode] = useState<"diff" | "all">("diff");
  const [viewMode, setViewMode] = useState<"tree" | "list">("tree");
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
              currentSession={currentSession}
              showUnscoped={showUnscoped}
              extraSessions={r.name === repo ? extraSessions : EMPTY_SESSIONS}
              sessionCounts={sessionCounts}
              legacyCount={legacyCount}
              onSelectRepo={onSelectRepo}
              onSelectSession={onSelectSession}
              onSelectLegacy={onSelectLegacy}
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
          <div className="file-mode-toggle" role="group" aria-label="Review scope">
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
          <div className="ft-toolbar">
            <span className="ttl">{fileMode === "all" ? "All files" : "Changed"}</span>
            <div className="seg" role="group" aria-label="File view">
              <button
                type="button"
                className={viewMode === "tree" ? "on" : ""}
                aria-pressed={viewMode === "tree"}
                onClick={() => setViewMode("tree")}
              >
                Tree
              </button>
              <button
                type="button"
                className={viewMode === "list" ? "on" : ""}
                aria-pressed={viewMode === "list"}
                onClick={() => setViewMode("list")}
              >
                List
              </button>
            </div>
          </div>
          {/* key remounts the tree on repo/mode switch so collapse state and
              the memoized tree re-initialize for the right file set. */}
          {viewMode === "tree" ? (
            <FileTree
              key={`${repo}:${fileMode}:${currentSession ?? ""}`}
              repo={repo}
              entries={treeEntries}
              viewed={viewed}
              threadCounts={threadCounts}
              activeFile={activeFile}
              onSelectFile={onSelectFile}
            />
          ) : (
            <FileList
              entries={treeEntries}
              viewed={viewed}
              threadCounts={threadCounts}
              activeFile={activeFile}
              onSelectFile={onSelectFile}
            />
          )}
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
  viewed,
  threadCounts,
  activeFile,
  onSelectFile,
}: {
  repo: string;
  entries: FileTreeEntry[];
  viewed: Set<string>;
  threadCounts: Map<string, number>;
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
          viewed={viewed}
          threadCounts={threadCounts}
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
  viewed,
  threadCounts,
  activeFile,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggleDir: (path: string) => void;
  viewed: Set<string>;
  threadCounts: Map<string, number>;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  // Indent is driven entirely by --depth (the CSS draws guides + padding); a
  // file's depth is already one past its folder, so no manual chevron offset.
  const depthVar = { "--depth": depth } as CSSProperties;

  if (node.type === "file") {
    const unchanged = node.status === "unchanged";
    return (
      <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        className={`tree-file${node.path === activeFile ? " active" : ""}${
          unchanged ? " unchanged" : ""
        }`}
        style={depthVar}
        title={unchanged ? `${node.path} — unchanged, open to comment` : node.path}
        onClick={() => onSelectFile(node.path)}
      >
        <Icon
          name={statusIcon(node.status)}
          size={12}
          className={`tree-icon status-${node.status}`}
        />
        <span className="tree-name">{node.name}</span>
        <FileBadges
          status={node.status}
          file={node.file}
          viewed={viewed.has(node.path)}
          threads={threadCounts.get(node.path) ?? 0}
        />
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
        style={depthVar}
        onClick={() => onToggleDir(node.path)}
      >
        <Icon
          name={isCollapsed ? "chevron-right" : "chevron-down"}
          size={12}
          className="tree-chevron"
        />
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
            viewed={viewed}
            threadCounts={threadCounts}
            activeFile={activeFile}
            onSelectFile={onSelectFile}
          />
        ))}
    </>
  );
}

/** Right-aligned per-file badges: open-thread count, viewed mark, diffstat. */
function FileBadges({
  status,
  file,
  viewed,
  threads,
}: {
  status: TreeFileStatus;
  file?: DiffFile;
  viewed: boolean;
  threads: number;
}) {
  const unchanged = status === "unchanged";
  const hasStat = file && (file.additions > 0 || file.deletions > 0);
  if (!threads && unchanged && !hasStat) return null;
  return (
    <span className="ft-badges">
      {threads > 0 && (
        <span className="ft-tcount" title={`${threads} open thread${threads === 1 ? "" : "s"}`}>
          {threads}
        </span>
      )}
      {!unchanged &&
        (viewed ? (
          <span className="ft-viewed" title="Viewed" aria-hidden="true">
            ✓
          </span>
        ) : (
          <span className="ft-unviewed" title="Not viewed" aria-hidden="true" />
        ))}
      {hasStat && (
        <span className="ft-stat">
          {file!.additions > 0 && <span className="a">+{file!.additions}</span>}
          {file!.additions > 0 && file!.deletions > 0 ? " " : ""}
          {file!.deletions > 0 && <span className="d">&minus;{file!.deletions}</span>}
        </span>
      )}
    </span>
  );
}

/** Flat list view: filename + muted parent path, in tree (folders-first) order. */
function FileList({
  entries,
  viewed,
  threadCounts,
  activeFile,
  onSelectFile,
}: {
  entries: FileTreeEntry[];
  viewed: Set<string>;
  threadCounts: Map<string, number>;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  const files = useMemo(() => flattenTree(buildPathTree(entries)), [entries]);
  return (
    <div className="file-list">
      {files.map((node) => {
        const slash = node.path.lastIndexOf("/");
        const dir = slash >= 0 ? node.path.slice(0, slash) : "";
        return (
          <button
            type="button"
            key={node.path}
            className={`lfile${node.path === activeFile ? " active" : ""}`}
            title={node.path}
            onClick={() => onSelectFile(node.path)}
          >
            <span className="lname">{node.name}</span>
            {dir && <span className="lpath">{dir}</span>}
            <FileBadges
              status={node.status}
              file={node.file}
              viewed={viewed.has(node.path)}
              threads={threadCounts.get(node.path) ?? 0}
            />
          </button>
        );
      })}
    </div>
  );
}

/** Depth-first flatten of the built tree into files, preserving display order. */
function flattenTree(nodes: TreeNode[]): TreeFile[] {
  const out: TreeFile[] = [];
  for (const node of nodes) {
    if (node.type === "file") out.push(node);
    else out.push(...flattenTree(node.children));
  }
  return out;
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
  currentSession,
  showUnscoped,
  extraSessions,
  sessionCounts,
  legacyCount,
  onSelectRepo,
  onSelectSession,
  onSelectLegacy,
}: {
  repo: RepoSummary;
  active: boolean;
  currentSession: string | null;
  showUnscoped: boolean;
  extraSessions: ReviewSession[];
  sessionCounts: Map<string, number>;
  legacyCount: number;
  onSelectRepo: (repo: string) => void;
  onSelectSession: (session: ReviewSession) => void;
  onSelectLegacy: () => void;
}) {
  // The branch of the primary checkout — what "this repo" is on. Shown as a muted
  // subtitle so a repo whose sole session is implicit (no list rendered) still
  // surfaces its branch on the repo row itself.
  const primaryBranch =
    repo.worktrees.find((w) => w.root === repo.root)?.branch ??
    repo.worktrees[0]?.branch ??
    null;

  // Server-derived sessions first (the stable per-worktree work reviews), then
  // any reconstructed/ad-hoc ones, deduped so a stale server feed can't double a
  // reconstructed entry. A lone session needs no list — the repo row is it; the
  // list appears once there's a real choice (multiple sessions or legacy threads).
  const sessions = useMemo(() => {
    const seen = new Set(repo.sessions.map((s) => s.id));
    return [...repo.sessions, ...extraSessions.filter((s) => !seen.has(s.id))];
  }, [repo.sessions, extraSessions]);
  const showSessions = active && (sessions.length > 1 || legacyCount > 0);

  return (
    <div>
      <button
        type="button"
        className={`repo-item ${active ? "active" : ""}`}
        onClick={() => onSelectRepo(repo.name)}
      >
        <span className="repo-name">{repo.name}</span>
        {primaryBranch && (
          <span className="repo-branch" title={`On branch ${primaryBranch}`}>
            <Icon name="git-branch" size={11} className="repo-branch-icon" />
            {primaryBranch}
          </span>
        )}
      </button>
      {showSessions && (
        <div className="session-list">
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              label={sessionLabel(s.scope)}
              detail={sessionDetail(s.scope)}
              count={sessionCounts.get(s.id) ?? 0}
              active={!showUnscoped && s.id === currentSession}
              onClick={() => onSelectSession(s)}
            />
          ))}
          {legacyCount > 0 && (
            <SessionItem
              label="Unscoped"
              detail="pre-scope comments"
              count={legacyCount}
              active={showUnscoped}
              onClick={onSelectLegacy}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SessionItem({
  label,
  detail,
  count,
  active,
  onClick,
}: {
  label: string;
  detail: string | null;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`session-item ${active ? "active" : ""}`}
      onClick={onClick}
      title={detail ? `${label} — ${detail}` : label}
    >
      <Icon name="git-branch" size={11} className="session-icon" />
      <span className="session-name">{label}</span>
      {detail && <span className="session-detail">{detail}</span>}
      {count > 0 && (
        <span className="session-count" title={`${count} comment${count === 1 ? "" : "s"}`}>
          {count}
        </span>
      )}
    </button>
  );
}
