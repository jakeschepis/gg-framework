/**
 * Off-screen padding kept mounted above/below the transcript viewport, in pixels.
 *
 * Generous on top because scrolling up to re-read is the common gesture and a
 * blank flash there is jarring; smaller below because new content arrives at
 * the bottom and is measured as it streams in. Mirrors the padding Cline and
 * Roo Code settle on for the same "agent transcript in a webview" problem.
 *
 * Lives outside `TranscriptList.tsx` so that file exports only its component —
 * a non-component export there disables React Fast Refresh for it.
 */
export const TRANSCRIPT_VIEWPORT_PADDING = { top: 2400, bottom: 1200 } as const;

/**
 * Height assumed for a transcript row that has not been measured yet. Only
 * affects the scrollbar estimate before measurement; Virtuoso corrects it per
 * row via its ResizeObserver. Sized for a short assistant paragraph.
 */
export const TRANSCRIPT_DEFAULT_ROW_HEIGHT = 120;
