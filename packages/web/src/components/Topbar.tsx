import type { RefList, WorkspaceInfo } from "@diffect/shared";
import type { Theme } from "../theme.js";
import { TargetPicker } from "./TargetPicker.js";

interface Props {
  workspace: WorkspaceInfo;
  repo: string;
  onRepo: (repo: string) => void;
  worktree: string | null;
  onWorktree: (worktree: string | null) => void;
  target: string;
  onTarget: (target: string) => void;
  refs: RefList | null;
  openCount: number;
  theme: Theme;
  onToggleTheme: () => void;
  paneCollapsed: boolean;
  onTogglePane: () => void;
}

/** The application header: workspace path, repo/worktree/target selectors, and
 * the open-count + theme/pane controls. */
export function Topbar({
  workspace,
  repo,
  onRepo,
  worktree,
  onWorktree,
  target,
  onTarget,
  refs,
  openCount,
  theme,
  onToggleTheme,
  paneCollapsed,
  onTogglePane,
}: Props) {
  const currentRepo = workspace.repos.find((r) => r.name === repo) ?? null;
  const multiRepo = workspace.repos.length > 1;
  const worktrees = currentRepo?.worktrees ?? [];
  const multiWorktree = worktrees.length > 1;

  return (
    <header className="topbar">
      <span className="brand">Diffect</span>
      <span className="workspace-path" title={workspace.root}>
        {workspace.root}
      </span>

      {multiRepo && (
        <select
          className="selector"
          value={repo}
          onChange={(e) => onRepo(e.target.value)}
          title="Repository"
        >
          {workspace.repos.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      )}

      {multiWorktree && (
        <select
          className="selector"
          value={worktree ?? ""}
          onChange={(e) => onWorktree(e.target.value || null)}
          title="Worktree (A/B)"
        >
          <option value="">all worktrees</option>
          {worktrees.map((w) => (
            <option key={w.name} value={w.name}>
              {w.name}
            </option>
          ))}
        </select>
      )}

      <TargetPicker target={target} onTarget={onTarget} refs={refs} />

      <span className="spacer" />
      <span className="inbox">{openCount} open</span>
      <button
        type="button"
        className="theme-toggle"
        onClick={onToggleTheme}
        title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        aria-label="Toggle color theme"
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
      <button
        type="button"
        className="pane-toggle"
        onClick={onTogglePane}
        title={paneCollapsed ? "Show threads panel" : "Hide threads panel"}
        aria-label="Toggle threads panel"
      >
        {paneCollapsed ? "⟨" : "⟩"}
      </button>
    </header>
  );
}
