// Inline terminal image rendering via the iTerm2 and kitty graphics protocols.
//
// Two protocols cover the common graphics-capable terminals:
//   - "iterm"  → iTerm2 / WezTerm (OSC 1337 File=inline=1)
//   - "kitty"  → kitty / Ghostty   (APC _G chunked transmission)
//
// Detection defaults to "none" on any uncertainty (non-TTY, unknown TERM,
// tmux without passthrough) so we never emit raw escape sequences into a
// terminal that would print them as garbage.

export type GraphicsProtocol = "iterm" | "kitty" | "none";

/** kitty transmits image data in <= 4096-byte base64 chunks. */
const KITTY_CHUNK_SIZE = 4096;

/**
 * Detect which inline-image graphics protocol the current terminal supports.
 *
 * @param env   Environment to inspect (defaults to `process.env`).
 * @param isTTY Whether stdout is a TTY (defaults to `process.stdout.isTTY`).
 *              Graphics are only emitted to a real interactive terminal.
 */
export function detectGraphicsProtocol(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): GraphicsProtocol {
  if (!isTTY) return "none";

  // tmux rewrites/strips graphics sequences unless passthrough is configured.
  // We don't enable passthrough by default, so treat tmux as unsupported.
  if (env["TMUX"] || env["TERM"]?.includes("tmux") || env["TERM"]?.includes("screen")) {
    return "none";
  }

  const termProgram = env["TERM_PROGRAM"];

  // iTerm2 and WezTerm both implement the iTerm2 inline-image OSC.
  if (termProgram === "iTerm.app" || termProgram === "WezTerm" || env["WEZTERM_PANE"]) {
    return "iterm";
  }

  // kitty and Ghostty implement the kitty graphics protocol.
  if (env["KITTY_WINDOW_ID"] || env["TERM"]?.includes("kitty")) {
    return "kitty";
  }
  if (termProgram === "ghostty" || env["GHOSTTY_RESOURCES_DIR"] || env["GHOSTTY_BIN_DIR"]) {
    return "kitty";
  }

  return "none";
}

/**
 * Encode a base64 image payload into an inline-image escape sequence for the
 * given protocol. Returns an empty string for the "none" protocol so callers
 * can append unconditionally.
 *
 * When `rows` is given, the image is constrained to that many terminal cells
 * tall (aspect ratio preserved) and, for kitty, the cursor is told not to
 * move (`C=1`). Callers that interleave images with a TUI live frame need a
 * deterministic height — see `encodeInlineImageBlock`.
 */
export function encodeInlineImage(
  base64: string,
  protocol: GraphicsProtocol,
  rows?: number,
): string {
  if (protocol === "none" || base64.length === 0) return "";

  if (protocol === "iterm") {
    // OSC 1337 ; File = inline=1 ; preserveAspectRatio=1 : <base64> BEL
    const height = rows !== undefined ? `;height=${rows}` : "";
    return `\u001b]1337;File=inline=1;preserveAspectRatio=1${height}:${base64}\u0007`;
  }

  // kitty graphics protocol: chunked APC transmission.
  //   first chunk:  _G f=100,a=T,m=<1|0> ; <chunk> ST
  //   later chunks: _G m=<1|0> ; <chunk> ST
  // m=1 marks "more chunks follow", m=0 marks the final chunk.
  // r=<rows> scales the image to fit that many cells (width auto); C=1 keeps
  // the cursor where it is so the caller fully owns cursor movement.
  const sizing = rows !== undefined ? `,r=${rows},C=1` : "";
  const chunks: string[] = [];
  for (let offset = 0; offset < base64.length; offset += KITTY_CHUNK_SIZE) {
    const chunk = base64.slice(offset, offset + KITTY_CHUNK_SIZE);
    const isFirst = offset === 0;
    const isLast = offset + KITTY_CHUNK_SIZE >= base64.length;
    const more = isLast ? 0 : 1;
    const control = isFirst ? `f=100,a=T${sizing},m=${more}` : `m=${more}`;
    chunks.push(`\u001b_G${control};${chunk}\u001b\\`);
  }
  return chunks.join("");
}

/** Default preview height (in terminal rows) for inline image blocks. */
export const INLINE_IMAGE_ROWS = 12;

/**
 * Encode an inline image as a fixed-height block whose visual height exactly
 * matches its newline count.
 *
 * A raw image escape occupies many terminal rows while contributing zero
 * newlines to the written stream — any TUI layer that counts `\n`s to erase
 * or reposition its live frame (Ink's log-update does exactly that) then
 * erases at the wrong offset, stranding fragments of the old frame in
 * scrollback (orphaned `⏺` rows around the image).
 *
 * This emits `rows` real newlines to reserve the space (all scrolling is
 * caused by plain newlines every layer can account for), saves the cursor,
 * jumps to the top of the reserved block, draws the height-constrained image
 * there, and restores the cursor to the line after the block. The returned
 * string contains exactly `rows` newlines and renders exactly `rows` tall.
 */
export function encodeInlineImageBlock(
  base64: string,
  protocol: GraphicsProtocol,
  options?: { rows?: number; leftPad?: string },
): string {
  if (protocol === "none" || base64.length === 0) return "";
  const rows = Math.max(1, options?.rows ?? INLINE_IMAGE_ROWS);
  const leftPad = options?.leftPad ?? "";
  const image = encodeInlineImage(base64, protocol, rows);
  return (
    "\n".repeat(rows) + // reserve rows; the only source of scrolling
    "\u001b7" + // save cursor (start of the line after the block)
    `\u001b[${rows}A` + // up to the block's top row
    leftPad + // indent via printable spaces over the blank row
    image +
    "\u001b8" // restore — back to the line after the block
  );
}
