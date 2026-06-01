import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLlmsCandidates, createWebFetchTool, htmlToCleanText } from "./web-fetch.js";

const originalFetch = globalThis.fetch;

function context() {
  return { signal: new AbortController().signal, toolCallId: "test" };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("htmlToCleanText", () => {
  it("removes common ad, cookie, nav, and subscription boilerplate", () => {
    const html = `
      <html>
        <head><style>.ad { display: block; }</style><script>alert("track")</script></head>
        <body>
          <header>Site navigation</header>
          <nav>Products Docs Pricing</nav>
          <div class="cookie-banner">Accept all cookies</div>
          <main>
            <article>
              <h1>Useful documentation</h1>
              <p>This is the content the agent should read.</p>
              <div class="advertisement">Sponsored: buy this now</div>
              <p>Second useful paragraph &amp; details.</p>
            </article>
            <aside class="newsletter-signup">Subscribe to our newsletter</aside>
          </main>
          <footer>Legal links</footer>
        </body>
      </html>
    `;

    const result = htmlToCleanText(html);

    expect(result).toContain("Useful documentation");
    expect(result).toContain("This is the content the agent should read.");
    expect(result).toContain("Second useful paragraph & details.");
    expect(result).not.toContain("Site navigation");
    expect(result).not.toContain("Products Docs Pricing");
    expect(result).not.toContain("Accept all cookies");
    expect(result).not.toContain("Sponsored");
    expect(result).not.toContain("Subscribe to our newsletter");
    expect(result).not.toContain("Legal links");
  });

  it("removes accessibility skip-link boilerplate", () => {
    const result = htmlToCleanText(`
      <a href="#content">Skip to main content</a>
      <a href="#search">Skip to search</a>
      <main><h1>Fetch API</h1><p>Useful page body.</p></main>
    `);

    expect(result).toContain("Fetch API");
    expect(result).toContain("Useful page body.");
    expect(result).not.toContain("Skip to main content");
    expect(result).not.toContain("Skip to search");
  });
});

describe("buildLlmsCandidates", () => {
  it("includes origin, docs subpath, and page markdown candidates", () => {
    const candidates = buildLlmsCandidates("https://example.com/docs/guide/page.html?x=1", 10000);
    const urls = candidates.map((candidate) => candidate.url);

    expect(urls).toContain("https://example.com/llms.txt");
    expect(urls).toContain("https://example.com/docs/llms.txt");
    expect(urls).toContain("https://example.com/docs/guide/page.html.md?x=1");
  });
});

describe("createWebFetchTool", () => {
  it("returns sanitized HTML content from fetched pages", async () => {
    const html = `
      <html>
        <body>
          <nav>Skip Main navigation</nav>
          <article>
            <h1>API Reference</h1>
            <p>Use this endpoint to create a session.</p>
            <div id="ad-container">Advertisement: cloud hosting sale</div>
          </article>
          <footer>Terms Privacy</footer>
        </body>
      </html>
    `;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ) as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://example.com/docs" },
      context(),
    );

    expect(result).toContain("API Reference");
    expect(result).toContain("Use this endpoint to create a session.");
    expect(result).not.toContain("Skip Main navigation");
    expect(result).not.toContain("Advertisement");
    expect(result).not.toContain("Terms Privacy");
  });

  it("returns markdown with a heading and fenced code by default", async () => {
    const html = `
      <html><head><title>Guide</title></head>
      <body>
        <article>
          <h1>Setup Guide</h1>
          <p>This is a sufficiently long introductory paragraph so the
          Readability extractor treats the page as a genuine article and emits
          structured markdown for the agent to consume in tests.</p>
          <pre><code>npm install thing</code></pre>
          <p>Another descriptive paragraph that adds enough body length to clear
          the minimum article-length threshold comfortably during extraction.</p>
        </article>
      </body></html>
    `;
    globalThis.fetch = vi.fn(
      async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    ) as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://example.com/guide", format: "markdown" },
      context(),
    );

    expect(result).toContain("# Guide");
    expect(result).toContain("Setup Guide");
    expect(result).toContain("```");
    expect(result).toContain("npm install thing");
  });

  it("falls back to clean text when the extractor is unavailable", async () => {
    const html = `<html><body><article><h1>Fallback</h1><p>Body content for fallback.</p></article></body></html>`;
    globalThis.fetch = vi.fn(
      async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    ) as typeof fetch;

    // Force the markdown extractor to throw so the tool degrades to text.
    const extract = await import("./html-extract.js");
    const spy = vi
      .spyOn(extract, "extractToMarkdown")
      .mockRejectedValue(new extract.ExtractorUnavailable("stubbed missing"));

    const result = await createWebFetchTool().execute(
      { url: "https://example.com/page", format: "markdown" },
      context(),
    );

    expect(spy).toHaveBeenCalled();
    expect(result).toContain("Fallback");
    expect(result).toContain("Body content for fallback.");
    spy.mockRestore();
  });

  it("follows a safe same-host redirect and returns the final content", async () => {
    const finalHtml = `<html><body><article><h1>Final Page</h1><p>Redirect target body.</p></article></body></html>`;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://example.com/final/" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(finalHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ) as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://example.com/redirect", format: "text" },
      context(),
    );

    expect(result).toContain("Final Page");
    expect(result).toContain("Redirect target body.");
    expect(result).not.toContain("Redirects are not followed");
  });

  it("blocks redirects to private/internal URLs", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:3000/secret" },
        }),
    ) as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://example.com/redirect" },
      context(),
    );

    expect(result).toContain("Redirect blocked");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/redirect",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("stops after too many redirects", async () => {
    let hop = 0;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://example.com/hop${hop++}` },
        }),
    ) as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://example.com/loop" },
      context(),
    );

    expect(result).toContain("too many redirects");
  });

  it("blocks private/internal URLs before fetching", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "http://127.0.0.1:3000/secret" },
      context(),
    );

    expect(result).toContain("URL blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches multiple URLs into ordered sections, reporting per-URL failures", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("page-a")) {
        return new Response(
          `<html><body><article><h1>Alpha</h1><p>Alpha body.</p></article></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as typeof fetch;

    const result = (await createWebFetchTool().execute(
      {
        urls: ["https://example.com/page-a", "https://example.com/page-b"],
        format: "text",
      },
      context(),
    )) as string;

    const idxA = result.indexOf("## https://example.com/page-a");
    const idxB = result.indexOf("## https://example.com/page-b");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(result).toContain("Alpha");
    expect(result).toContain("HTTP 404");
  });

  it("reports a blocked private URL only within its own section", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          `<html><body><article><h1>Public</h1><p>Public body text.</p></article></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    ) as typeof fetch;

    const result = await createWebFetchTool().execute(
      {
        urls: ["https://example.com/public", "http://127.0.0.1/secret"],
        format: "text",
      },
      context(),
    );

    expect(result).toContain("## http://127.0.0.1/secret");
    expect(result).toContain("URL blocked");
    expect(result).toContain("Public");
  });

  it("extracts text from a PDF response", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const fixturePath = fileURLToPath(new URL("./__fixtures__/sample.pdf", import.meta.url));
    const bytes = await readFile(fixturePath);

    globalThis.fetch = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    ) as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://example.com/file.pdf" },
      context(),
    );

    expect(result).toContain("[PDF");
    expect(result).toContain("Hello PDF World");
  });

  it("prefers a site's llms.txt for doc-ish pages and skips scraping the page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/llms.txt")) {
        return new Response(
          "# Docs Index\n\n" + "This is the curated llms.txt content. ".repeat(10),
          { status: 200, headers: { "content-type": "text/plain" } },
        );
      }
      return new Response("<html><body>page</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://docs.example.com/reference/api" },
      context(),
    );

    expect(result).toContain("[llms.txt for docs.example.com]");
    expect(result).toContain("curated llms.txt content");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows safe redirects while probing llms resources", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.example.com/llms.txt") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://platform.example.com/docs/llms.txt" },
        });
      }
      if (url === "https://platform.example.com/docs/llms.txt") {
        return new Response("# Redirected Docs\n\n" + "Redirected llms content. ".repeat(10), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://docs.example.com/reference/api" },
      context(),
    );

    expect(result).toContain("[llms.txt for docs.example.com]");
    expect(result).toContain("Source: https://platform.example.com/docs/llms.txt");
    expect(result).toContain("Redirected llms content");
  });

  it("prefers docs-subpath llms.txt when origin llms.txt is absent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/llms.txt") {
        return new Response("not found", { status: 404 });
      }
      if (url === "https://example.com/docs/llms.txt") {
        return new Response("# Docs Root\n\n" + "Subpath llms content. ".repeat(10), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://example.com/docs/guide/intro" },
      context(),
    );

    expect(result).toContain("[llms.txt for example.com]");
    expect(result).toContain("Source: https://example.com/docs/llms.txt");
    expect(result).toContain("Subpath llms content");
  });

  it("accepts markdown-looking llms body with octet-stream content type", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("# Docs Index\n\n" + "- [Guide](./guide)\n- [API](./api)\n".repeat(8), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    ) as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://docs.example.com/api" },
      context(),
    );

    expect(result).toContain("[llms.txt for docs.example.com]");
    expect(result).toContain("Docs Index");
  });

  it("rejects HTML error pages served with status 200", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("llms") || url.endsWith(".md")) {
        return new Response(
          "<!doctype html><html><head><title>404 Not Found</title></head><body>Missing</body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        );
      }
      return new Response(
        `<html><body><article><h1>Real Docs</h1><p>Scraped fallback content.</p></article></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://docs.example.com/guide/page", format: "text" },
      context(),
    );

    expect(result).toContain("Real Docs");
    expect(result).not.toContain("404 Not Found");
  });

  it("tries page URL .md when llms variants are absent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/reference/page.html.md")) {
        return new Response("# Page Markdown\n\n" + "Specific markdown source. ".repeat(10), {
          status: 200,
          headers: { "content-type": "" },
        });
      }
      if (url.includes("llms")) return new Response("not found", { status: 404 });
      return new Response("page", { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://example.com/reference/page.html" },
      context(),
    );

    expect(result).toContain("[Markdown source for example.com/reference/page.html.md]");
    expect(result).toContain("Specific markdown source");
  });

  it("uses preferred docs resources for multi-URL fetch sections", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.a.com/llms.txt") {
        return new Response("# A Docs\n\n" + "A llms content. ".repeat(10), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://docs.b.com/llms.txt") {
        return new Response("# B Docs\n\n" + "B llms content. ".repeat(10), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createWebFetchTool().execute(
      { urls: ["https://docs.a.com/api", "https://docs.b.com/guide"] },
      context(),
    );

    expect(result).toContain("## https://docs.a.com/api");
    expect(result).toContain("A llms content");
    expect(result).toContain("## https://docs.b.com/guide");
    expect(result).toContain("B llms content");
  });

  it("falls through to scraping when llms.txt is absent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/llms.txt")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        `<html><body><article><h1>Real Docs</h1><p>Scraped body content here.</p></article></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://docs.example.com/guide/intro", format: "text" },
      context(),
    );

    expect(result).toContain("Real Docs");
    expect(fetchMock).toHaveBeenCalledWith("https://docs.example.com/llms.txt", expect.anything());
    expect(fetchMock).toHaveBeenCalledWith(
      "https://docs.example.com/guide/intro",
      expect.anything(),
    );
  });

  it("skips the llms.txt probe when prefer_llms_txt is false", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          `<html><body><article><h1>Direct</h1><p>Direct page body content.</p></article></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createWebFetchTool().execute(
      { url: "https://docs.example.com/reference/api", prefer_llms_txt: false, format: "text" },
      context(),
    );

    expect(result).toContain("Direct");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
