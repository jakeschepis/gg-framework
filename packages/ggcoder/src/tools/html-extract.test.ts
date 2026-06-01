import { describe, expect, it } from "vitest";
import { extractToMarkdown, loadExtractor } from "./html-extract.js";

// Probe at module load so describe.skipIf sees the real value at collection time.
const extractorInstalled = await loadExtractor()
  .then(() => true)
  .catch(() => false);

const ARTICLE_HTML = `
<html>
  <head><title>Test Article</title></head>
  <body>
    <nav>Home Products Pricing Docs</nav>
    <aside class="advert">Sponsored: buy now</aside>
    <article>
      <h1>Understanding the Fetch API</h1>
      <p>The Fetch API provides a modern interface for making HTTP requests in
      JavaScript. It returns promises and is widely supported across browsers.
      This paragraph is intentionally long enough to clear the Readability
      content-length threshold so extraction succeeds in tests reliably.</p>
      <h2>Example</h2>
      <pre><code>const res = await fetch(url);
const data = await res.json();</code></pre>
      <h2>Comparison</h2>
      <table>
        <thead><tr><th>Method</th><th>Returns</th></tr></thead>
        <tbody>
          <tr><td>fetch</td><td>Promise</td></tr>
          <tr><td>XHR</td><td>callback</td></tr>
        </tbody>
      </table>
      <ul><li>First item</li><li>Second item</li></ul>
      <p>A closing paragraph with more substantial body text so the article
      comfortably exceeds the minimum length that Readability requires before it
      is considered a real article worth extracting.</p>
    </article>
    <footer>Legal links and copyright</footer>
  </body>
</html>
`;

describe.skipIf(!extractorInstalled)("extractToMarkdown", () => {
  it("extracts main content as markdown with title, code fence, and table", async () => {
    const result = await extractToMarkdown(ARTICLE_HTML, "https://example.com/article");
    expect(result).not.toBeNull();
    const md = result?.markdown ?? "";

    expect(result?.title).toBe("Test Article");
    expect(md).toContain("Understanding the Fetch API");
    expect(md).toContain("```");
    expect(md).toContain("await fetch(url)");
    // GFM table rendered with pipe separators.
    expect(md).toMatch(/\|\s*Method\s*\|/);
    expect(md).toContain("First item");
    // Nav, ads, and footer boilerplate dropped.
    expect(md).not.toContain("Sponsored: buy now");
    expect(md).not.toContain("Home Products Pricing");
  });

  it("returns null for trivially short content", async () => {
    const result = await extractToMarkdown(
      "<html><body><p>Too short.</p></body></html>",
      "https://example.com/short",
    );
    expect(result).toBeNull();
  });
});
