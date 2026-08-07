// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Virtuoso decides its window from real layout (element rects, ResizeObserver),
 * none of which jsdom provides — under test it renders zero rows, so asserting
 * "mounted < all" against the real component would pass vacuously and prove
 * nothing. So the virtualizer is faked here with an explicit window, which
 * tests the property this component actually owns: rows are built on demand
 * through `itemContent`, never eagerly mapped. Real virtualization is verified
 * against the running app (see the per-window RSS measurement).
 */
const WINDOW_START = 40;
const WINDOW_SIZE = 20;
const virtuosoProps = vi.fn();

vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
    computeItemKey?: (index: number, item: unknown) => React.Key;
    [key: string]: unknown;
  }) => {
    virtuosoProps(props);
    const slice = props.data.slice(WINDOW_START, WINDOW_START + WINDOW_SIZE);
    return (
      <div data-testid="virtuoso">
        {slice.map((item, offset) => {
          const index = WINDOW_START + offset;
          return (
            <div key={props.computeItemKey?.(index, item) ?? index}>
              {props.itemContent(index, item)}
            </div>
          );
        })}
      </div>
    );
  },
}));

const { TranscriptList } = await import("./TranscriptList");
const { TRANSCRIPT_VIEWPORT_PADDING } = await import("./transcript-window");

interface Row {
  id: number;
  text: string;
}

const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: i, text: `row ${i}` }));

function renderList(count: number, renderItem?: (row: Row) => React.ReactElement) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return render(
    <TranscriptList
      items={rows(count)}
      itemKey={(row) => row.id}
      scrollParent={parent}
      isPinned={() => true}
      renderItem={renderItem ?? ((row) => <div data-test-row={row.id}>{row.text}</div>)}
    />,
    { container: parent },
  );
}

describe("TranscriptList virtualization", () => {
  it("mounts only the rows in the window, not the whole session", () => {
    renderList(5000);
    const mounted = document.querySelectorAll("[data-test-row]");
    expect(mounted).toHaveLength(WINDOW_SIZE);
    // Rows outside the window are absent from the DOM entirely — that is what
    // releases their markdown subtrees and decoded images.
    expect(screen.queryByText("row 0")).toBeNull();
    expect(screen.queryByText("row 4999")).toBeNull();
    expect(screen.getByText(`row ${WINDOW_START}`)).toBeTruthy();
  });

  it("never builds a row it does not mount", () => {
    const renderItem = vi.fn((row: Row) => <div data-test-row={row.id}>{row.text}</div>);
    renderList(5000, renderItem);
    // The regression this guards: reverting to `items.map(...)` would call this
    // 5000 times and rebuild every markdown subtree on every render.
    expect(renderItem).toHaveBeenCalledTimes(WINDOW_SIZE);
  });

  it("keeps the mounted count flat as the session grows", () => {
    const small = renderList(200);
    const smallCount = document.querySelectorAll("[data-test-row]").length;
    small.unmount();

    const large = renderList(20_000);
    const largeCount = document.querySelectorAll("[data-test-row]").length;
    large.unmount();

    // A 100x longer session must not cost 100x the DOM.
    expect(largeCount).toBe(smallCount);
  });

  it("virtualizes against the existing transcript scroller", () => {
    const parent = document.createElement("div");
    render(
      <TranscriptList
        items={rows(10)}
        itemKey={(row) => row.id}
        scrollParent={parent}
        isPinned={() => true}
        renderItem={(row) => <div data-test-row={row.id}>{row.text}</div>}
      />,
    );
    const calls = virtuosoProps.mock.calls;
    const props = calls[calls.length - 1][0];
    // Reusing App's `.transcript` element is what lets the existing
    // stick-to-bottom machinery keep working untouched.
    expect(props.customScrollParent).toBe(parent);
    expect(props.increaseViewportBy).toBe(TRANSCRIPT_VIEWPORT_PADDING);
  });

  it("keys rows by identity so streaming edits do not remount the list", () => {
    renderList(5000);
    const calls = virtuosoProps.mock.calls;
    const props = calls[calls.length - 1][0];
    expect(props.computeItemKey(WINDOW_START, { id: 77, text: "x" })).toBe(77);
  });

  it("renders nothing until the scroll parent exists", () => {
    const { container } = render(
      <TranscriptList
        items={rows(10)}
        itemKey={(row) => row.id}
        scrollParent={null}
        isPinned={() => true}
        renderItem={(row) => <div data-test-row={row.id}>{row.text}</div>}
      />,
    );
    expect(container.querySelectorAll("[data-test-row]")).toHaveLength(0);
  });

  it("opens a resumed session at the newest row, not the top of the day", () => {
    renderList(5000);
    const calls = virtuosoProps.mock.calls;
    const props = calls[calls.length - 1][0];
    // Regression guard: a virtualized scroller has an estimated height, so
    // App's scrollHeight-based pin lands at the top without this.
    expect(props.initialTopMostItemIndex).toBe(4999);
  });

  it("follows streaming output only while the view is pinned", () => {
    const parent = document.createElement("div");
    let pinned = true;
    render(
      <TranscriptList
        items={rows(10)}
        itemKey={(row) => row.id}
        scrollParent={parent}
        isPinned={() => pinned}
        renderItem={(row) => <div data-test-row={row.id}>{row.text}</div>}
      />,
    );
    const calls = virtuosoProps.mock.calls;
    const props = calls[calls.length - 1][0];
    expect(props.followOutput()).toBe("auto");
    // Scrolled up to read mid-stream: the view must not be yanked back.
    pinned = false;
    expect(props.followOutput()).toBe(false);
  });

  it("pads the viewport on both sides so scrolling does not flash blank", () => {
    expect(TRANSCRIPT_VIEWPORT_PADDING.top).toBeGreaterThan(0);
    expect(TRANSCRIPT_VIEWPORT_PADDING.bottom).toBeGreaterThan(0);
  });
});
