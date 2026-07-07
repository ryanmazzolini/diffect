import { useState } from "react";
import type { Thread } from "@diffect/shared";
import { ThreadConversation } from "./ThreadConversation.js";

/** Inline thread renderer shared by diff surfaces. */
export function InlineThread({
  thread,
  onChanged,
}: {
  thread: Thread;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(thread.status === "open");
  if (!expanded) {
    const first = thread.comments[0]?.body.split("\n")[0] ?? "";
    return (
      <button
        type="button"
        className={`thread-collapsed status-${thread.status}`}
        onClick={() => setExpanded(true)}
        title="Show thread"
      >
        <span className={`status-badge status-${thread.status}`}>
          {thread.status}
        </span>
        <span className="thread-collapsed-preview">{first}</span>
      </button>
    );
  }
  return <ThreadConversation thread={thread} onChanged={onChanged} />;
}
