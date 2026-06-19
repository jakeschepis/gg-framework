import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openProjectPath } from "./agent";
import "highlight.js/styles/github-dark.css";

interface Props {
  children: string;
}

function isExternalHref(href: string): boolean {
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  return Boolean(scheme && scheme !== "file" && scheme.length > 1);
}

/**
 * Anchor that opens outside the webview. Browser links go to the OS browser;
 * file-ish links from the agent (`src/App.tsx`, `/abs/file.ts`, `file://…`) open
 * against the current project window's cwd.
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
        if (!href || href.startsWith("#")) return;
        e.preventDefault();
        if (isExternalHref(href)) {
          void openUrl(href);
        } else {
          void openProjectPath(href);
        }
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
