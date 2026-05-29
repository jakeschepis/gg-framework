// Terminal focus reporting emits CSI I / CSI O when the terminal window gains
// or loses focus. In normal raw input these arrive as ESC [ I and ESC [ O, but
// some terminal/Ink/tmux combinations can split or strip the ESC byte so the
// application sees literal "[I" / "[O" chunks. If those reach text inputs or
// filterable selectors they become visible garbage like `[I[O[I`.
const ESC = String.fromCharCode(27);
const ESC_FOCUS_GAINED = `${ESC}[I`;
const ESC_FOCUS_LOST = `${ESC}[O`;
const ESC_LESS_FOCUS_GAINED = "[I";
const ESC_LESS_FOCUS_LOST = "[O";

export function stripTerminalFocusSequences(input: string): string {
  const withoutEscFocusReports = input
    .replaceAll(ESC_FOCUS_GAINED, "")
    .replaceAll(ESC_FOCUS_LOST, "");
  let remaining = withoutEscFocusReports;

  while (remaining.length > 0) {
    if (remaining.startsWith(ESC_LESS_FOCUS_GAINED) || remaining.startsWith(ESC_LESS_FOCUS_LOST)) {
      remaining = remaining.slice(2);
      continue;
    }

    return withoutEscFocusReports;
  }

  return "";
}

export function isTerminalFocusSequence(input: string): boolean {
  return stripTerminalFocusSequences(input).length === 0 && input.length > 0;
}
