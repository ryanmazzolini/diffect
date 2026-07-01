import { useState } from "react";
import type { Severity, Side } from "@diffect/shared";
import { api } from "../api.js";
import { useDraft } from "../useDraft.js";
import { MarkdownEditor } from "./MarkdownEditor.js";

const SEVERITIES: Severity[] = ["must-fix", "suggestion", "nit", "question"];

interface Props {
  repo: string | null;
  spacePath?: string | null;
  worktree: string | null;
  /** The review target spec the comment is filed under (e.g. "work",
   * "main..feat"); the daemon resolves it to the durable scope/session. */
  target: string;
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
  spacePath = null,
  worktree,
  target,
  file,
  side,
  line,
  endLine = null,
  onCancel,
  onCreated,
}: Props) {
  // Persist the in-progress comment per location so it survives a re-render or
  // an SSE-driven diff reload and an accidental cancel.
  const draftKey = `draft:${repo ?? spacePath ?? "space"}:${worktree ?? ""}:${side}:${file}:${line}:${
    endLine ?? line
  }`;
  const [body, setBody, clearDraft] = useDraft(draftKey);
  const [severity, setSeverity] = useState<Severity | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rangeText =
    endLine && endLine !== line ? `lines ${line} to ${endLine}` : `line ${line}`;

  const submit = async () => {
    if (!body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createThread({
        repo,
        spacePath,
        worktree,
        target,
        targetLevel: "file",
        file,
        side,
        line,
        endLine: endLine && endLine !== line ? endLine : null,
        severity: severity || null,
        body: body.trim(),
      });
      clearDraft();
      onCreated();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="comment-form">
      {endLine && endLine !== line && (
        <div className="comment-form-title">Add a comment on {rangeText}</div>
      )}
      <MarkdownEditor
        autoFocus
        placeholder={`Comment on ${file}:${line}${
          endLine && endLine !== line ? `-${endLine}` : ""
        }`}
        value={body}
        onChange={setBody}
        onSubmitKey={submit}
        onCancelKey={onCancel}
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
