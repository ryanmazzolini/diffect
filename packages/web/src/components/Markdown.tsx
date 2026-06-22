import MarkdownPreview from "@uiw/react-markdown-preview/nohighlight";
import rehypeSanitize from "rehype-sanitize";

const REHYPE_PLUGINS = [rehypeSanitize];

/** Render comment markdown through one sanitized preview path. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <MarkdownPreview
        source={children}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
        }}
      />
    </div>
  );
}
