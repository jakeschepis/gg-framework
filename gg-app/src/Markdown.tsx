import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import "highlight.js/styles/github-dark.css";

interface Props {
  children: string;
}

/**
 * Anchor that opens in the OS browser instead of navigating the webview. In a
 * Tauri webview a bare <a href> would replace the app's own page (or open a
 * dead in-app tab), so we intercept the click and hand the URL to the opener
 * plugin. Non-http(s) targets (anchors, mailto handled by the OS) pass through.
 */
function ExternalLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        void openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Renders assistant text as GitHub-flavored markdown with syntax-highlighted
 * fenced code blocks. Mirrors the TUI's Markdown.tsx role in the web build.
 * Memoized so unchanged blocks don't re-parse while later turns stream.
 */
export const Markdown = memo(function Markdown({ children }: Props): React.ReactElement {
  // Models sometimes emit literal backslash-n instead of real newlines, which
  // react-markdown would render verbatim. Normalize them to real newlines
  // (mirrors the TUI's presentation.ts) and trim leading/trailing blank lines.
  const normalized = children.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ a: ExternalLink }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});
