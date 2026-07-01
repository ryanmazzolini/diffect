import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import type {
  DiffFile,
  RepoSummary,
  ReviewScope,
  ReviewSession,
} from "@diffect/shared";
import { Icon, type IconName } from "../icons.js";
import { getStored, setStored } from "../storage.js";
import {
  buildPathTree,
  type FileTreeEntry,
  type TreeFileStatus,
  type TreeNode,
} from "../fileTree.js";

interface Props {
  repo: string;
  /** Id of the session the active diff resolved to — remounts the file tree on review switch. */
  currentSession: string | null;
  /** The unscoped/legacy bucket is open; no session entry is highlighted. */
  showUnscoped: boolean;
  /** Sessions archived for the active repo (durable + optimistic), routed to a
   *  collapsed Archived group instead of the active list. */
  archivedSessions: ReviewSession[];
  /** Thread count per session id, plus the legacy bucket under `__legacy__`. */
  sessionCounts: Map<string, number>;
  /** Pre-scope thread count; the unscoped bucket renders only when > 0. */
  legacyCount: number;
  repos: RepoSummary[];
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
  onCollapse: () => void;
  editorLabel: string | null;
  onOpenFile: (path: string) => void;
}


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

function sessionDetail(_scope: ReviewScope): string | null {
  return null;
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

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Left navigation: workspace → repos (when needed) → files. Memoized so a
 * diff/thread change doesn't re-render the whole nav. */
export const Sidebar = memo(function Sidebar({
  repo,
  repos,
  currentSession,
  showUnscoped,
  archivedSessions,
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
  onCollapse,
  editorLabel,
  onOpenFile,
}: Props) {
  const [fileMode, setFileMode] = useState<"diff" | "all">("diff");
  const treeEntries = useMemo(
    () => (fileMode === "all" ? allFileEntries(allFiles, files) : diffFileEntries(files)),
    [allFiles, fileMode, files],
  );
  const showFiles = files.length > 0 || allFiles.length > 0;
  const showRepoList = repos.length > 1;
  const showRecovery = legacyCount > 0 || archivedSessions.length > 0;
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openContextMenu = (path: string, event: MouseEvent) => {
    if (!editorLabel) return;
    event.preventDefault();
    setMenu({ path, x: event.clientX, y: event.clientY });
  };

  return (
    <nav className="sidebar">
      <div className="sidebar-panel-head">
        <span className="sidebar-panel-title">Files</span>
        <button
          type="button"
          className="sidebar-panel-toggle"
          onClick={onCollapse}
          title="Hide files sidebar"
          aria-label="Hide files sidebar"
        >
          <Icon name="sidebar-collapse" size={14} />
        </button>
      </div>
      {showRepoList && (
        <>
          <div className="sidebar-head sidebar-top-head">
            <span>Repos</span>
          </div>
          <div className="ws-group">
            {repos.map((r) => (
              <RepoItem
                key={r.name}
                repo={r}
                active={r.name === repo}
                onSelectRepo={onSelectRepo}
              />
            ))}
          </div>
        </>
      )}

      {showFiles && (
        <>
          <div className="sidebar-head files-head">
            <span>{fileMode === "all" ? "All files" : "Changed"}</span>
            <span className="files-head-actions">
              {fileMode === "diff" && (
                <ReviewProgress
                  files={files}
                  viewed={viewed}
                  activeFile={activeFile}
                  onSelectFile={onSelectFile}
                />
              )}
              <button
                type="button"
                className="file-scope-link"
                onClick={() => {
                  if (fileMode === "all") {
                    setFileMode("diff");
                    onShowDiff();
                  } else {
                    setFileMode("all");
                  }
                }}
              >
                {fileMode === "all" ? "Changed files" : "All files"}
              </button>
            </span>
          </div>
          {/* key remounts the tree on repo/mode switch so collapse state and
              the memoized tree re-initialize for the right file set. */}
          <FileTree
            key={`${repo}:${fileMode}:${currentSession ?? ""}`}
            repo={repo}
            entries={treeEntries}
            viewed={viewed}
            threadCounts={threadCounts}
            activeFile={activeFile}
            onSelectFile={onSelectFile}
            onContextMenu={openContextMenu}
          />
        </>
      )}

      {menu && editorLabel && (
        <div
          className="context-menu file-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenFile(menu.path);
              setMenu(null);
            }}
          >
            Open in {editorLabel}
          </button>
        </div>
      )}

      {showRecovery && (
        <ReviewRecovery
          archivedSessions={archivedSessions}
          sessionCounts={sessionCounts}
          legacyCount={legacyCount}
          showUnscoped={showUnscoped}
          onSelectSession={onSelectSession}
          onSelectLegacy={onSelectLegacy}
        />
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
  onContextMenu,
}: {
  repo: string;
  entries: FileTreeEntry[];
  viewed: Set<string>;
  threadCounts: Map<string, number>;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent) => void;
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
          onContextMenu={onContextMenu}
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
  onContextMenu,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggleDir: (path: string) => void;
  viewed: Set<string>;
  threadCounts: Map<string, number>;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent) => void;
}) {
  // Indent is driven entirely by --depth (the CSS draws guides + padding); a
  // file's depth is already one past its folder, so no manual chevron offset.
  const depthVar = { "--depth": depth } as CSSProperties;

  if (node.type === "file") {
    const unchanged = node.status === "unchanged";
    const ignored = node.file?.ignored ?? false;
    let title = node.path;
    if (ignored) title = `${node.path} — ignored by git`;
    else if (unchanged) title = `${node.path} — unchanged, open to comment`;
    return (
      <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        className={`tree-file${node.path === activeFile ? " active" : ""}${
          unchanged ? " unchanged" : ""
        }${ignored ? " ignored" : ""}`}
        style={depthVar}
        title={title}
        onClick={() => onSelectFile(node.path)}
        onContextMenu={(event) => onContextMenu(node.path, event)}
      >
        <Icon
          name={statusIcon(node.status)}
          size={12}
          className={`tree-icon status-${node.status}${ignored ? " ignored" : ""}`}
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
            onContextMenu={onContextMenu}
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
  const ignored = file?.ignored ?? false;
  const hasStat = file && (file.additions > 0 || file.deletions > 0);
  if (!threads && unchanged && !hasStat && !ignored) return null;
  return (
    <span className="ft-badges">
      {threads > 0 && (
        <span className="ft-tcount" title={`${threads} open thread${threads === 1 ? "" : "s"}`}>
          {threads}
        </span>
      )}
      {ignored && (
        <span className="ft-ignored" title="Ignored by git">
          ignored
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
  onSelectRepo,
}: {
  repo: RepoSummary;
  active: boolean;
  onSelectRepo: (repo: string) => void;
}) {
  const primaryBranch =
    repo.worktrees.find((w) => w.root === repo.root)?.branch ??
    repo.worktrees[0]?.branch ??
    null;
  const repoLabel = basename(repo.root);

  return (
    <button
      type="button"
      className={`repo-item ${active ? "active" : ""}`}
      onClick={() => onSelectRepo(repo.name)}
      title={`${repoLabel}${repoLabel === repo.name ? "" : ` (${repo.name})`}\n${repo.root}`}
    >
      <span className="repo-name">{repoLabel}</span>
      {primaryBranch && (
        <span className="repo-branch" title={`On branch ${primaryBranch}`}>
          <Icon name="git-branch" size={11} className="repo-branch-icon" />
          {primaryBranch}
        </span>
      )}
    </button>
  );
}

function ReviewRecovery({
  archivedSessions,
  sessionCounts,
  legacyCount,
  showUnscoped,
  onSelectSession,
  onSelectLegacy,
}: {
  archivedSessions: ReviewSession[];
  sessionCounts: Map<string, number>;
  legacyCount: number;
  showUnscoped: boolean;
  onSelectSession: (session: ReviewSession) => void;
  onSelectLegacy: () => void;
}) {
  const total = legacyCount + archivedSessions.length;
  return (
    <details className="review-recovery">
      <summary>
        <span>Completed reviews</span>
        <span className="archived-count">{total}</span>
      </summary>
      <div className="session-list recovery-list">
        {legacyCount > 0 && (
          <SessionItem
            label="Unscoped"
            detail="pre-scope comments"
            count={legacyCount}
            active={showUnscoped}
            onClick={onSelectLegacy}
          />
        )}
        {archivedSessions.map((s) => (
          <SessionItem
            key={s.id}
            label={sessionLabel(s.scope)}
            detail={sessionDetail(s.scope)}
            count={sessionCounts.get(s.id) ?? 0}
            active={false}
            onClick={() => onSelectSession(s)}
          />
        ))}
      </div>
    </details>
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
  onClick?: () => void;
}) {
  const title = detail ? `${label} — ${detail}` : label;
  return (
    <button
      type="button"
      className={`session-item ${active ? "active" : ""}`}
      onClick={onClick}
      title={title}
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
