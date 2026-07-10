import { Icon } from "../icons.js";

interface Props {
  repoLabel: string | null;
  filePath: string | null;
  mode: "diff" | "space";
  follow: boolean;
  followAvailable: boolean;
  onToggleFollow: () => void;
}

function pathParts(path: string): { dir: string | null; file: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return { dir: parts.slice(0, -1).join("/") || null, file: parts.at(-1) ?? path };
}

export function StatusBar({ repoLabel, filePath, mode, follow, followAvailable, onToggleFollow }: Props) {
  const parts = filePath ? pathParts(filePath) : null;
  const crumb = filePath ? [repoLabel, filePath].filter(Boolean).join(" / ") : repoLabel;
  const followActive = follow && followAvailable;
  const followLabel = follow && !followAvailable ? "Follow paused" : "Follow changes";
  const followTitle = followAvailable
    ? follow
      ? "Stop following changed files"
      : "Follow changed files"
    : "Follow works only with working tree or unstaged targets";
  return (
    <footer className="statusbar" aria-label="Review status">
      <div className="statusbar-left">
        <span className="statusbar-dot" aria-hidden="true" />
        <span className="statusbar-crumb" title={crumb ?? "No file selected"}>
          {crumb ? (
            <>
              <span>{mode === "space" ? "space" : repoLabel}</span>
              {parts && (
                <>
                  <span className="statusbar-sep">/</span>
                  {parts.dir && <span className="statusbar-path">{parts.dir}/</span>}
                  <span className="statusbar-file">{parts.file}</span>
                </>
              )}
            </>
          ) : (
            "No file selected"
          )}
        </span>
      </div>
      <div className="statusbar-right">
        <button
          type="button"
          className={`statusbar-pill statusbar-follow${followActive ? " active" : ""}`}
          aria-pressed={follow}
          title={followTitle}
          onClick={onToggleFollow}
        >
          <Icon name={followActive ? "eye" : "eye-closed"} size={12} className="statusbar-follow-icon" />
          {followLabel}
        </button>
      </div>
    </footer>
  );
}
