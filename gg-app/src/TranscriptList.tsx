import { forwardRef, useImperativeHandle, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { TRANSCRIPT_DEFAULT_ROW_HEIGHT, TRANSCRIPT_VIEWPORT_PADDING } from "./transcript-window";

export interface TranscriptListHandle {
  /**
   * Pin to the newest row.
   *
   * App cannot do this with `el.scrollTo(scrollHeight)` any more: only the rows
   * near the viewport exist, so the scroller's height is an estimate that
   * changes as rows materialize. Asking Virtuoso to scroll to the last index
   * lands correctly regardless of what has been measured.
   */
  scrollToBottom: () => void;
}

export interface TranscriptListProps<T> {
  items: readonly T[];
  /** Stable identity per row — same value App used as the React key. */
  itemKey: (item: T) => React.Key;
  renderItem: (item: T) => React.ReactElement | null;
  /**
   * The `.transcript` element. Virtuoso virtualizes against this existing
   * scroller rather than creating its own, which is what lets App keep its
   * stick-to-bottom machinery (scrollRef, onScroll, the layout-effect re-pin)
   * exactly as it was. Null on the first render, before the ref attaches.
   */
  scrollParent: HTMLElement | null;
  /**
   * Whether the view is currently pinned to the bottom. Read on every append so
   * streaming output follows the newest row, while a user who scrolled up to
   * read is left alone.
   */
  isPinned: () => boolean;
}

/**
 * The transcript, virtualized: only rows near the viewport stay mounted.
 *
 * Every mounted row costs a full markdown parse plus highlight.js tokenization,
 * and WebKit holds layout, style, and decoded-image data for all of it. Keeping
 * a whole day's session mounted pushed single windows past `1.5 GB`, so the
 * mounted set is now bounded by what's actually on screen instead of by how
 * long the session ran. Items stay in App's state untouched — this bounds only
 * what is rendered.
 *
 * Rows are rendered through `itemContent`, so a row that is scrolled away is
 * unmounted and its DOM, highlight markup, and decoded images are released.
 */
function TranscriptListInner<T>(
  { items, itemKey, renderItem, scrollParent, isPinned }: TranscriptListProps<T>,
  ref: React.ForwardedRef<TranscriptListHandle>,
): React.ReactElement | null {
  const virtuoso = useRef<VirtuosoHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: () => {
        if (items.length === 0) return;
        virtuoso.current?.scrollToIndex({ index: items.length - 1, align: "end" });
      },
    }),
    [items.length],
  );

  // Before the scroll parent attaches there is nothing to virtualize against.
  // Rendering the rows unvirtualized here would defeat the point, and Virtuoso
  // needs a real scroller, so hold off one paint — items arrive after hydration
  // anyway, well after the ref lands.
  if (!scrollParent) return null;
  return (
    <Virtuoso
      ref={virtuoso}
      data={items as T[]}
      customScrollParent={scrollParent}
      increaseViewportBy={TRANSCRIPT_VIEWPORT_PADDING}
      defaultItemHeight={TRANSCRIPT_DEFAULT_ROW_HEIGHT}
      computeItemKey={(_index, item) => itemKey(item)}
      itemContent={(_index, item) => renderItem(item)}
      // Resuming a session must land on the newest row, not the top of the day.
      initialTopMostItemIndex={Math.max(0, items.length - 1)}
      // Keep streaming output in view, but never yank a user who scrolled up.
      followOutput={() => (isPinned() ? "auto" : false)}
    />
  );
}

export const TranscriptList = forwardRef(TranscriptListInner) as <T>(
  props: TranscriptListProps<T> & { ref?: React.Ref<TranscriptListHandle> },
) => React.ReactElement | null;
