import type { RefList, WorkspaceInfo } from "@diffect/shared";
import type { Theme } from "../theme.js";
import { Icon } from "../icons.js";
import { TargetPicker } from "./TargetPicker.js";

interface Props {
  workspace: WorkspaceInfo;
  target: string;
  onTarget: (target: string) => void;
  refs: RefList | null;
  theme: Theme;
  onToggleTheme: () => void;
  paneCollapsed: boolean;
  onTogglePane: () => void;
  onToggleSidebar: () => void;
}

/** Application header: sidebar toggle, brand/path, the review-target picker, and
 * the theme/pane controls. Repo/worktree selection and review progress live in
 * the sidebar; thread counts live on the thread-pane filter bar. */
export function Topbar({
  workspace,
  target,
  onTarget,
  refs,
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
        className="icon-btn hamburger"
        onClick={onToggleSidebar}
        title="Toggle sidebar"
        aria-label="Toggle sidebar"
      >
        <Icon name="three-bars" />
      </button>
      <span className="brand">Diffect</span>
      <span className="workspace-path" title={workspace.root}>
        {workspace.root}
      </span>

      <TargetPicker target={target} onTarget={onTarget} refs={refs} />

      <span className="spacer" />
      <button
        type="button"
        className="icon-btn theme-toggle"
        onClick={onToggleTheme}
        title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        aria-label="Toggle color theme"
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} />
      </button>
      <button
        type="button"
        className="icon-btn pane-toggle"
        onClick={onTogglePane}
        title={paneCollapsed ? "Show threads panel" : "Hide threads panel"}
        aria-label="Toggle threads panel"
      >
        <Icon name={paneCollapsed ? "sidebar-expand" : "sidebar-collapse"} />
      </button>
    </header>
  );
}
