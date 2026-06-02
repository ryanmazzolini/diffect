import type { RefList, WorkspaceInfo } from "@diffect/shared";
import type { Theme } from "../theme.js";
import { TargetPicker } from "./TargetPicker.js";

interface Props {
  workspace: WorkspaceInfo;
  target: string;
  onTarget: (target: string) => void;
  refs: RefList | null;
  openCount: number;
  theme: Theme;
  onToggleTheme: () => void;
  paneCollapsed: boolean;
  onTogglePane: () => void;
  onToggleSidebar: () => void;
}

/** Application header: sidebar toggle, brand/path, the review-target picker, and
 * the open-count + theme/pane controls. Repo/worktree selection lives in the
 * sidebar. */
export function Topbar({
  workspace,
  target,
  onTarget,
  refs,
  openCount,
  theme,
  onToggleTheme,
  paneCollapsed,
  onTogglePane,
  onToggleSidebar,
}: Props) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="hamburger"
        onClick={onToggleSidebar}
        title="Toggle sidebar"
        aria-label="Toggle sidebar"
      >
        ☰
      </button>
      <span className="brand">Diffect</span>
      <span className="workspace-path" title={workspace.root}>
        {workspace.root}
      </span>

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
