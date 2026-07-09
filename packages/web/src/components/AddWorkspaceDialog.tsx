import { useEffect, useState } from "react";
import type {
  FsListing,
  RecommendedWorkspace,
  WorkspaceEntry,
} from "@diffect/shared";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { Modal } from "./Modal.js";

interface Props {
  onClose: () => void;
  onAdded: (entries: WorkspaceEntry[], addedPath: string) => void;
}

/** Replaces the native prompt: a path field, an in-app folder browser, and a list
 * of recently-active projects sourced from Claude/pi sessions. */
export function AddWorkspaceDialog({ onClose, onAdded }: Props) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recs, setRecs] = useState<RecommendedWorkspace[]>([]);
  const [listing, setListing] = useState<FsListing | null>(null);

  useEffect(() => {
    api.recommendations().then(setRecs).catch(() => setRecs([]));
  }, []);

  const add = async (p: string) => {
    if (!p.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const addedPath = p.trim();
      onAdded(await api.addWorkspace(addedPath), addedPath);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const browse = async (p?: string) => {
    try {
      const l = await api.fsList(p);
      setListing(l);
      setPath(l.path);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal title="Add workspace" onClose={onClose}>
      <div className="aw-row">
        <input
          className="aw-input"
          placeholder="/path/to/repo"
          value={path}
          autoFocus
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add(path);
          }}
        />
        <button type="button" className="ghost" onClick={() => void browse()}>
          Browse…
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !path.trim()}
          onClick={() => void add(path)}
        >
          Add
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {listing && (
        <div className="aw-browser">
          <div className="aw-browser-head">
            <button
              type="button"
              className="ghost aw-up"
              disabled={!listing.parent}
              onClick={() => void browse(listing.parent ?? undefined)}
            >
              <Icon name="chevron-left" size={12} /> Up
            </button>
            <span className="aw-cwd" title={listing.path}>
              {listing.path}
            </span>
          </div>
          <ul className="aw-dirs">
            {listing.entries.length === 0 && <li className="muted">No sub-folders</li>}
            {listing.entries.map((e) => (
              <li key={e.path}>
                <button type="button" className="aw-dir" onClick={() => void browse(e.path)}>
                  <Icon name="file-directory-fill" size={14} />
                  {e.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recs.length > 0 && (
        <div className="aw-recs">
          <div className="aw-recs-head">Recent projects</div>
          {recs.map((r) => (
            <button
              type="button"
              key={r.path}
              className="aw-rec"
              disabled={busy}
              onClick={() => void add(r.path)}
            >
              <Icon name="file-directory-fill" size={14} />
              <span className="aw-rec-name">{r.name}</span>
              <span className="aw-rec-path" title={r.path}>
                {r.path}
              </span>
              <span className="aw-rec-meta">
                {r.source} · {relativeTime(r.lastActiveAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
