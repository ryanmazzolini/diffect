import type { RepoSummary, WorkspaceEntry } from "@diffect/shared";
import { Icon } from "../icons.js";

interface Props {
  entries: WorkspaceEntry[];
  repo: string;
  worktree: string | null;
  onSelectRepo: (repo: string) => void;
  onSelectWorktree: (worktree: string | null) => void;
  files: string[];
  activeFile: string | null;
  onSelectFile: (path: string) => void;
  onAddWorkspace: () => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Left navigation: workspaces → repos → worktrees, plus the current file list. */
export function Sidebar({
  entries,
  repo,
  worktree,
  onSelectRepo,
  onSelectWorktree,
  files,
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
          <div className="ws-path" title={ws.path}>
            {basename(ws.path)}
          </div>
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
          <div className="sidebar-head">Files</div>
          {files.map((f) => (
            <button
              key={f}
              type="button"
              className={`file-item ${f === activeFile ? "active" : ""}`}
              title={f}
              onClick={() => onSelectFile(f)}
            >
              {basename(f)}
            </button>
          ))}
        </>
      )}
    </nav>
  );
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
