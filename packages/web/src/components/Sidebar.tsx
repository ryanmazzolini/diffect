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
} from "@diffect/shared";
import { Icon } from "../icons.js";
import { getStored, setStored } from "../storage.js";
import {
  buildPathTree,
  type FileTreeEntry,
  type TreeFileStatus,
  type TreeNode,
} from "../fileTree.js";

interface Props {
  repo: string | null;
  spacePath: string;
  /** Id of the session the active diff resolved to — remounts the file tree on review switch. */
  currentSession: string | null;
  /** The unscoped/legacy bucket is open; no session entry is highlighted. */
  showUnscoped: boolean;
  /** Pre-scope thread count; the unscoped bucket renders only when > 0. */
  legacyCount: number;
  repos: RepoSummary[];
  onSelectRepo: (repo: string) => void;
  onSelectLegacy: () => void;
  spaceFiles: string[];
  filesByRepo: Map<string, DiffFile[]>;
  allFilesByRepo: Map<string, string[]>;
  /** Open-thread count per repo/file path, plus space files. */
  threadCountsByRepo: Map<string, Map<string, number>>;
  spaceThreadCounts: Map<string, number>;
  activeFile: string | null;
  activeSpaceFile: string | null;
  onSelectFile: (repo: string | null, path: string) => void;
  onShowDiff: () => void;
  onFileModeChange: (mode: "diff" | "all") => void;
  onCollapse: () => void;
  editorLabel: string | null;
  onOpenRepoFile: (repo: string, path: string) => void;
  onOpenSpaceFile: (path: string) => void;
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

const collapsedReposKey = (spacePath: string) => `diffect-space-tree-repos:${spacePath}`;

function loadCollapsedRepos(spacePath: string): Set<string> {
  try {
    const raw = getStored(collapsedReposKey(spacePath));
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Left navigation: one space-level tree: space files plus repo folders. */
export const Sidebar = memo(function Sidebar({
  repo,
  spacePath,
  repos,
  currentSession,
  showUnscoped,
  legacyCount,
  onSelectRepo,
  onSelectLegacy,
  spaceFiles,
  filesByRepo,
  allFilesByRepo,
  threadCountsByRepo,
  spaceThreadCounts,
  activeFile,
  activeSpaceFile,
  onSelectFile,
  onShowDiff,
  onFileModeChange,
  onCollapse,
  editorLabel,
  onOpenRepoFile,
  onOpenSpaceFile,
}: Props) {
  const [fileMode, setFileMode] = useState<"diff" | "all">("diff");
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => loadCollapsedRepos(spacePath));
  const [menu, setMenu] = useState<{ repo: string | null; path: string; x: number; y: number } | null>(null);

  useEffect(() => setCollapsedRepos(loadCollapsedRepos(spacePath)), [spacePath]);
  useEffect(() => onFileModeChange(fileMode), [fileMode, onFileModeChange]);

  const repoEntries = useMemo(
    () =>
      repos.map((r) => {
        const changed = filesByRepo.get(r.name) ?? [];
        return {
          repo: r,
          entries:
            fileMode === "all"
              ? allFileEntries(allFilesByRepo.get(r.name) ?? [], changed)
              : diffFileEntries(changed),
        };
      }),
    [allFilesByRepo, fileMode, filesByRepo, repos],
  );
  const spaceEntries = useMemo<FileTreeEntry[]>(
    () =>
      fileMode === "all"
        ? spaceFiles.map((path) => ({ path, status: "unchanged" }))
        : [],
    [fileMode, spaceFiles],
  );
  const showFiles =
    spaceEntries.length > 0 || repoEntries.some((entry) => entry.entries.length > 0) || repos.length > 0;

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

  const openContextMenu = (fileRepo: string | null, path: string, event: MouseEvent) => {
    if (!editorLabel) return;
    event.preventDefault();
    setMenu({ repo: fileRepo, path, x: event.clientX, y: event.clientY });
  };

  const storeCollapsedRepos = (next: Set<string>) => {
    setStored(collapsedReposKey(spacePath), JSON.stringify([...next]));
    return next;
  };
  const toggleRepo = (name: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return storeCollapsedRepos(next);
    });
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

      {showFiles && (
        <>
          <div className="sidebar-head files-head">
            <span>{fileMode === "all" ? "Space tree" : "Diff tree"}</span>
            <span className="files-head-actions">
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
          {spaceEntries.length > 0 && (
            <FileTree
              key={`space:${spacePath}:${fileMode}`}
              storageKey={`space:${spacePath}:${fileMode}`}
              entries={spaceEntries}
              threadCounts={spaceThreadCounts}
              activeFile={activeSpaceFile}
              onSelectFile={(path) => onSelectFile(null, path)}
              onContextMenu={(path, event) => openContextMenu(null, path, event)}
            />
          )}

          <div className="space-repo-tree">
            {repoEntries.map(({ repo: r, entries }) => {
              const collapsed = collapsedRepos.has(r.name);
              const primaryBranch =
                r.worktrees.find((w) => w.root === r.root)?.branch ??
                r.worktrees[0]?.branch ??
                null;
              const label = basename(r.root);
              return (
                <div className="space-repo-node" key={r.name}>
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    className={`tree-repo${r.name === repo ? " active" : ""}`}
                    title={`${label}${label === r.name ? "" : ` (${r.name})`}\n${r.root}`}
                    onClick={() => {
                      onSelectRepo(r.name);
                      toggleRepo(r.name);
                    }}
                  >
                    <Icon
                      name={collapsed ? "chevron-right" : "chevron-down"}
                      size={12}
                      className="tree-chevron"
                    />
                    <Icon name="file-directory-fill" size={13} className="tree-icon" />
                    <span className="tree-repo-copy">
                      <span className="tree-repo-name">{label}</span>
                      {primaryBranch && (
                        <span className="tree-repo-branch" title={`On branch ${primaryBranch}`}>
                          <Icon name="git-branch" size={11} className="repo-branch-icon" />
                          {primaryBranch}
                        </span>
                      )}
                    </span>
                  </button>
                  {!collapsed && entries.length > 0 && (
                    <FileTree
                      key={`${r.name}:${fileMode}:${currentSession ?? ""}`}
                      storageKey={`${spacePath}:${r.name}:${fileMode}`}
                      entries={entries}
                              threadCounts={threadCountsByRepo.get(r.name) ?? new Map()}
                      activeFile={r.name === repo ? activeFile : null}
                      onSelectFile={(path) => onSelectFile(r.name, path)}
                      onContextMenu={(path, event) => openContextMenu(r.name, path, event)}
                      baseDepth={1}
                    />
                  )}
                </div>
              );
            })}
          </div>
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
              if (menu.repo) onOpenRepoFile(menu.repo, menu.path);
              else onOpenSpaceFile(menu.path);
              setMenu(null);
            }}
          >
            Open in {editorLabel}
          </button>
        </div>
      )}

      {legacyCount > 0 && (
        <LegacyComments
          count={legacyCount}
          active={showUnscoped}
          onSelect={onSelectLegacy}
        />
      )}
    </nav>
  );
});

const collapsedKey = (storageKey: string) => `diffect-tree-collapsed:${storageKey}`;

function loadCollapsed(storageKey: string): Set<string> {
  try {
    const raw = getStored(collapsedKey(storageKey));
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function dirPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (node: TreeNode) => {
    if (node.type !== "dir") return;
    paths.push(node.path);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return paths;
}

function findDir(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.type !== "dir") continue;
    if (node.path === path) return node;
    const found = findDir(node.children, path);
    if (found) return found;
  }
  return null;
}

/** Collapsible file tree, expansion state persisted per logical tree. */
function FileTree({
  storageKey,
  entries,
  threadCounts,
  activeFile,
  onSelectFile,
  onContextMenu,
  baseDepth = 0,
}: {
  storageKey: string;
  entries: FileTreeEntry[];
  threadCounts: Map<string, number>;
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent) => void;
  baseDepth?: number;
}) {
  const tree = useMemo(() => buildPathTree(entries), [entries]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(storageKey));
  const treeRef = useRef<HTMLDivElement>(null);

  const storeCollapsed = (next: Set<string>) => {
    setStored(collapsedKey(storageKey), JSON.stringify([...next]));
    return next;
  };

  useEffect(() => setCollapsed(loadCollapsed(storageKey)), [storageKey]);

  // Keep the scroll-spy-highlighted file visible without yanking the whole list:
  // `nearest` only scrolls the sidebar the minimum needed.
  useEffect(() => {
    if (!activeFile) return;
    treeRef.current
      ?.querySelector(".tree-file.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeFile]);

  const toggleDir = (path: string, recursive: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      const closing = !next.has(path);
      const dir = recursive ? findDir(tree, path) : null;
      const paths = recursive && dir?.type === "dir" ? dirPaths([dir]) : [path];
      for (const p of paths) closing ? next.add(p) : next.delete(p);
      return storeCollapsed(next);
    });

  return (
    <div className="file-tree" ref={treeRef}>
      {tree.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={baseDepth}
          collapsed={collapsed}
          onToggleDir={toggleDir}
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
  threadCounts,
  activeFile,
  onSelectFile,
  onContextMenu,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggleDir: (path: string, recursive: boolean) => void;
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
    const glyph = fileGlyph(node.name);
    let title = node.path;
    if (ignored) title = `${node.path} — ignored by git`;
    else if (unchanged) title = `${node.path} — unchanged, open to comment`;
    return (
      <button
        type="button"
        className={`tree-file${node.path === activeFile ? " active" : ""}${
          unchanged ? " unchanged" : ""
        }${ignored ? " ignored" : ""}`}
        style={depthVar}
        title={title}
        onClick={() => onSelectFile(node.path)}
        onContextMenu={(event) => onContextMenu(node.path, event)}
      >
        {glyph ? (
          <span className="ft-glyph" style={{ color: glyph.color }} aria-hidden="true">
            {glyph.glyph}
          </span>
        ) : (
          <Icon name="file" size={12} className={`tree-icon${ignored ? " ignored" : ""}`} />
        )}
        <span className="tree-name">{node.name}</span>
        <FileBadges
          status={node.status}
          file={node.file}
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
        aria-expanded={!isCollapsed}
        className="tree-dir"
        style={depthVar}
        title="Option-click to collapse or expand descendants"
        onClick={(event) => onToggleDir(node.path, event.altKey)}
      >
        <Icon
          name={isCollapsed ? "chevron-right" : "chevron-down"}
          size={12}
          className="tree-chevron"
        />
        <Icon name="file-directory-fill" size={12} className="tree-icon" />
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
              threadCounts={threadCounts}
            activeFile={activeFile}
            onSelectFile={onSelectFile}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  );
}

/** Right-aligned per-file badges: open-thread count, then a change-status dot. */
function FileBadges({
  status,
  file,
  threads,
}: {
  status: TreeFileStatus;
  file?: DiffFile;
  threads: number;
}) {
  const unchanged = status === "unchanged";
  const ignored = file?.ignored ?? false;
  if (!threads && unchanged && !ignored) return null;
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
      {!unchanged && <span className={`ft-dot s-${status}`} title={status} aria-hidden="true" />}
    </span>
  );
}

// ponytail: tiny ext→glyph map instead of a filetype icon set; extend per demand.
const FILE_GLYPHS: Record<string, { glyph: string; color: string }> = {
  ts: { glyph: "TS", color: "#4d9fd6" },
  tsx: { glyph: "TS", color: "#4d9fd6" },
  js: { glyph: "JS", color: "#cdb54a" },
  jsx: { glyph: "JS", color: "#cdb54a" },
  mjs: { glyph: "JS", color: "#cdb54a" },
  cjs: { glyph: "JS", color: "#cdb54a" },
  json: { glyph: "{}", color: "#8f939c" },
  avsc: { glyph: "{}", color: "#8f939c" },
  yml: { glyph: "Y", color: "#b48cd9" },
  yaml: { glyph: "Y", color: "#b48cd9" },
  md: { glyph: "M", color: "#7d93d9" },
  rb: { glyph: "◆", color: "#e0716c" },
  py: { glyph: "Py", color: "#6cb2e0" },
  go: { glyph: "Go", color: "#4dc0d1" },
  rs: { glyph: "Rs", color: "#db9a6a" },
  hs: { glyph: "λ", color: "#a78bfa" },
  graphql: { glyph: "◇", color: "#e07ab0" },
  gql: { glyph: "◇", color: "#e07ab0" },
  css: { glyph: "#", color: "#6cb2e0" },
  scss: { glyph: "#", color: "#e07ab0" },
  html: { glyph: "<>", color: "#db9a6a" },
  sh: { glyph: "$", color: "#7fbf7f" },
  bash: { glyph: "$", color: "#7fbf7f" },
  zsh: { glyph: "$", color: "#7fbf7f" },
};

function fileGlyph(name: string): { glyph: string; color: string } | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return FILE_GLYPHS[name.slice(dot + 1).toLowerCase()] ?? null;
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

function LegacyComments({
  count,
  active,
  onSelect,
}: {
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <details className="review-recovery">
      <summary>
        <span>Older comments</span>
        <span className="recovery-count">{count}</span>
      </summary>
      <div className="session-list recovery-list">
        <SessionItem
          label="Unscoped"
          detail="pre-scope comments"
          count={count}
          active={active}
          onClick={onSelect}
        />
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
