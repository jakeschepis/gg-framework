import { describe, expect, it } from "vitest";
import {
  detectGraphicsProtocol,
  encodeInlineImage,
  encodeInlineImageBlock,
  INLINE_IMAGE_ROWS,
} from "./terminal-graphics.js";

describe("detectGraphicsProtocol", () => {
  it("detects iTerm2 and WezTerm as the iterm protocol", () => {
    expect(detectGraphicsProtocol({ TERM_PROGRAM: "iTerm.app" }, true)).toBe("iterm");
    expect(detectGraphicsProtocol({ TERM_PROGRAM: "WezTerm" }, true)).toBe("iterm");
    expect(detectGraphicsProtocol({ WEZTERM_PANE: "0" }, true)).toBe("iterm");
  });

  it("detects kitty, Ghostty, and xterm-kitty as the kitty protocol", () => {
    expect(detectGraphicsProtocol({ KITTY_WINDOW_ID: "1" }, true)).toBe("kitty");
    expect(detectGraphicsProtocol({ TERM: "xterm-kitty" }, true)).toBe("kitty");
    expect(detectGraphicsProtocol({ TERM_PROGRAM: "ghostty" }, true)).toBe("kitty");
    expect(detectGraphicsProtocol({ GHOSTTY_RESOURCES_DIR: "/x" }, true)).toBe("kitty");
  });

  it("returns none for unsupported terminals, missing env, and non-TTY", () => {
    expect(detectGraphicsProtocol({ TERM: "xterm-256color" }, true)).toBe("none");
    expect(detectGraphicsProtocol({}, true)).toBe("none");
    expect(detectGraphicsProtocol({ KITTY_WINDOW_ID: "1" }, false)).toBe("none");
  });

  it("returns none inside tmux even when a graphics terminal is detected", () => {
    expect(detectGraphicsProtocol({ KITTY_WINDOW_ID: "1", TMUX: "/tmp/tmux" }, true)).toBe("none");
    expect(detectGraphicsProtocol({ TERM: "screen-256color" }, true)).toBe("none");
  });
});

describe("encodeInlineImage", () => {
  const base64 = Buffer.from("hello world image bytes").toString("base64");

  it("produces a single iTerm2 OSC 1337 sequence terminated by BEL", () => {
    const out = encodeInlineImage(base64, "iterm");
    expect(out.startsWith("\u001b]1337;File=inline=1;preserveAspectRatio=1:")).toBe(true);
    expect(out.endsWith("\u0007")).toBe(true);
    expect(out).toContain(base64);
    // Exactly one BEL terminator → a single sequence.
    expect(out.split("\u0007")).toHaveLength(2);
  });

  it("returns an empty string for the none protocol or empty payload", () => {
    expect(encodeInlineImage(base64, "none")).toBe("");
    expect(encodeInlineImage("", "iterm")).toBe("");
  });

  it("chunks kitty payloads at 4096 chars with correct continuation markers", () => {
    const big = "A".repeat(4096 * 2 + 100);
    const out = encodeInlineImage(big, "kitty");
    const chunks = out.split("\u001b\\").filter((c) => c.length > 0);
    expect(chunks).toHaveLength(3);

    // First chunk carries the format/action keys and m=1 (more follow).
    expect(chunks[0].startsWith("\u001b_Gf=100,a=T,m=1;")).toBe(true);
    // Middle chunk is a continuation with m=1.
    expect(chunks[1].startsWith("\u001b_Gm=1;")).toBe(true);
    // Final chunk closes with m=0.
    expect(chunks[2].startsWith("\u001b_Gm=0;")).toBe(true);

    // Round-trip: concatenated payloads equal the input base64.
    const payloads = chunks.map((c) => c.slice(c.indexOf(";") + 1)).join("");
    expect(payloads).toBe(big);
  });

  it("emits a single final kitty chunk for payloads under one chunk", () => {
    const out = encodeInlineImage(base64, "kitty");
    const chunks = out.split("\u001b\\").filter((c) => c.length > 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startsWith("\u001b_Gf=100,a=T,m=0;")).toBe(true);
  });

  it("constrains image height in cells when rows is given", () => {
    expect(encodeInlineImage(base64, "iterm", 12)).toContain(";height=12:");
    const kitty = encodeInlineImage(base64, "kitty", 12);
    expect(kitty).toContain("r=12");
    // C=1: the caller owns cursor movement.
    expect(kitty).toContain("C=1");
  });
});

describe("encodeInlineImageBlock", () => {
  const base64 = Buffer.from("image bytes").toString("base64");

  it("returns empty for the none protocol or empty payload", () => {
    expect(encodeInlineImageBlock(base64, "none")).toBe("");
    expect(encodeInlineImageBlock("", "kitty")).toBe("");
  });

  it("contains exactly `rows` newlines so visual height matches line count", () => {
    for (const protocol of ["iterm", "kitty"] as const) {
      const out = encodeInlineImageBlock(base64, protocol, { rows: 8 });
      expect(out.split("\n")).toHaveLength(9); // 8 newlines
      const defaultOut = encodeInlineImageBlock(base64, protocol);
      expect(defaultOut.split("\n")).toHaveLength(INLINE_IMAGE_ROWS + 1);
    }
  });

  it("reserves rows first, then draws the height-constrained image into them", () => {
    const out = encodeInlineImageBlock(base64, "iterm", { rows: 8, leftPad: "   " });
    const newlinesEnd = out.lastIndexOf("\n") + 1;
    // All newlines precede the cursor choreography — nothing after them scrolls.
    expect(out.slice(0, newlinesEnd)).toBe("\n".repeat(8));
    const tail = out.slice(newlinesEnd);
    const save = tail.indexOf("\u001b7");
    const up = tail.indexOf("\u001b[8A");
    const image = tail.indexOf("\u001b]1337");
    const restore = tail.indexOf("\u001b8");
    expect(save).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(save);
    expect(image).toBeGreaterThan(up);
    expect(restore).toBeGreaterThan(image);
    expect(tail).toContain(";height=8:");
    expect(tail).toContain("   \u001b]1337");
  });
});
