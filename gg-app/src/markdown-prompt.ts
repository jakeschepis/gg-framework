import { isValidElement, type ReactNode } from "react";

// Pure helpers behind Ken's "Send to GG Coder" button. Kept dependency-free (no
// Tauri/agent imports) so they're unit-testable in a node env and reusable.
// ReactMarkdown hands the `pre` override a `<code class="language-xxx">…</code>`
// child: `codeLanguage` decides whether the fenced block becomes a Ken prompt
// button (language === "prompt"); `codeNodeText` extracts the exact body sent.

/** Extract the raw text from a fenced block's `<code>` child node tree. */
export function codeNodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(codeNodeText).join("");
  if (isValidElement(node)) {
    return codeNodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Read the `language-xxx` token off a fenced block's `<code>` child. */
export function codeLanguage(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const className = (children.props as { className?: string }).className ?? "";
  const match = /language-([\w-]+)/.exec(className);
  return match ? match[1] : null;
}
