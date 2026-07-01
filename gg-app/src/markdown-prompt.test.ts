import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { codeLanguage, codeNodeText } from "./markdown-prompt";

// These two helpers are the core of the "Send to GG Coder" button: ReactMarkdown
// hands the `pre` override a `<code class="language-xxx">…</code>` child.
// codeLanguage decides whether the block becomes a Ken prompt button (lang ===
// "prompt"); codeNodeText extracts the exact body that gets sent to GG Coder.

describe("codeLanguage (button trigger detection)", () => {
  it("detects a ```prompt fence (turns the block into the Send button)", () => {
    const code = createElement("code", { className: "language-prompt" }, "do the thing");
    expect(codeLanguage(code)).toBe("prompt");
  });

  it("returns the real language for ordinary fences (stays a code block)", () => {
    const ts = createElement("code", { className: "language-ts hljs" }, "const x = 1");
    expect(codeLanguage(ts)).toBe("ts");
  });

  it("returns null for a fence with no language class", () => {
    const plain = createElement("code", {}, "plain");
    expect(codeLanguage(plain)).toBeNull();
  });

  it("returns null when the child isn't an element (e.g. raw string)", () => {
    expect(codeLanguage("just text")).toBeNull();
  });

  it("is case-sensitive: ```Prompt is NOT the button (must be lowercase)", () => {
    const code = createElement("code", { className: "language-Prompt" }, "x");
    // Markdown lowercases fence info strings, so the real path is always
    // lowercase; this documents that "Prompt" != "prompt" in our matcher.
    expect(codeLanguage(code)).toBe("Prompt");
    expect(codeLanguage(code) === "prompt").toBe(false);
  });
});

describe("codeNodeText (what actually gets sent to GG Coder)", () => {
  it("extracts a plain string body", () => {
    const code = createElement("code", { className: "language-prompt" }, "Add a footer");
    expect(codeNodeText(code)).toBe("Add a footer");
  });

  it("joins multi-node children (syntax-highlight spans)", () => {
    const code = createElement(
      "code",
      { className: "language-prompt" },
      "Add ",
      createElement("span", {}, "dark mode"),
      " toggle",
    );
    expect(codeNodeText(code)).toBe("Add dark mode toggle");
  });

  it("preserves multi-line prompt bodies", () => {
    const body = "Line one of the prompt.\nLine two with detail.";
    const code = createElement("code", { className: "language-prompt" }, body);
    expect(codeNodeText(code)).toBe(body);
  });

  it("returns empty string for a null/empty node", () => {
    expect(codeNodeText(null)).toBe("");
    expect(codeNodeText(undefined)).toBe("");
  });
});
