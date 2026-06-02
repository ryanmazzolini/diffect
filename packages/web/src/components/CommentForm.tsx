import { useState } from "react";
import type { Severity, Side } from "@diffect/shared";
import { api } from "../api.js";

const SEVERITIES: Severity[] = ["must-fix", "suggestion", "nit", "question"];

interface Props {
  repo: string;
  worktree: string | null;
  file: string;
  side: Side;
  line: number;
  /** End of a multi-line range; null/equal-to-line means a single line. */
  endLine?: number | null;
  onCancel: () => void;
  onCreated: () => void;
}

export function CommentForm({
  repo,
  worktree,
  file,
  side,
  line,
  endLine = null,
  onCancel,
  onCreated,
}: Props) {
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<Severity | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createThread({
        repo,
        worktree,
        file,
        side,
        line,
        endLine: endLine && endLine !== line ? endLine : null,
        severity: severity || null,
        body: body.trim(),
      });
      onCreated();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="comment-form">
      <textarea
        autoFocus
        placeholder={`Comment on ${file}:${line}${
          endLine && endLine !== line ? `-${endLine}` : ""
        }`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="comment-form-actions">
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as Severity | "")}
        >
          <option value="">no severity</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button className="primary" onClick={submit} disabled={submitting || !body.trim()}>
          {submitting ? "Saving…" : "Comment"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
