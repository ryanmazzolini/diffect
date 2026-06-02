import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Render trusted-ish markdown safely. react-markdown builds React elements (no
 * innerHTML) and does not render embedded raw HTML by default, so comment bodies
 * — which may be authored by agents — can't inject markup, and non-safe URL
 * schemes (javascript:, data:) are stripped. remark-gfm adds task lists, tables,
 * and strikethrough so the toolbar's output renders. Links open in a new tab.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Drop react-markdown's `node` prop so it doesn't leak onto the DOM.
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
