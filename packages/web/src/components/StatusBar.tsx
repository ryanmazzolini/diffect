interface Props {
  repoLabel: string | null;
  filePath: string | null;
  mode: "diff" | "space";
}

function pathParts(path: string): { dir: string | null; file: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return { dir: parts.slice(0, -1).join("/") || null, file: parts.at(-1) ?? path };
}

export function StatusBar({ repoLabel, filePath, mode }: Props) {
  const parts = filePath ? pathParts(filePath) : null;
  const crumb = filePath ? [repoLabel, filePath].filter(Boolean).join(" / ") : repoLabel;
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
        <button type="button" className="statusbar-pill" disabled title="Follow-pi is planned">
          <span className="statusbar-switch" aria-hidden="true" />
          Follow pi
        </button>
        <span className="statusbar-pill muted" title="Terminal drawer planned for herdr integration">
          Terminal ⌥`
        </span>
      </div>
    </footer>
  );
}
