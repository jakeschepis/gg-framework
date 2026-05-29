import React from "react";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { getLiveAreaClampRows } from "../live-area-height.js";
import type { CompletedItem } from "../app-items.js";
import { ChatLiveArea } from "./ChatLayout.js";
import { StreamingArea } from "./StreamingArea.js";

interface ChatLivePaneProps {
  liveItems: CompletedItem[];
  renderItem: (item: CompletedItem, index: number, items: CompletedItem[]) => React.ReactNode;
  isRunning: boolean;
  visibleStreamingText: string;
  streamingThinking: string;
  thinkingMs: number;
  reserveStreamingSpacing: boolean;
  renderMarkdown: boolean;
  measuredLiveAreaRows: number;
  assistantMarginTop: number;
  streamingContinuation: boolean;
}

export function ChatLivePane({
  liveItems,
  renderItem,
  isRunning,
  visibleStreamingText,
  streamingThinking,
  thinkingMs,
  reserveStreamingSpacing,
  renderMarkdown,
  measuredLiveAreaRows,
  assistantMarginTop,
  streamingContinuation,
}: ChatLivePaneProps) {
  const { columns } = useTerminalSize();
  // Bound the WHOLE live area, not just each item: individual assistant blocks
  // truncate to the budget, but multiple stacked blocks (accumulated turns,
  // pinned text + streaming) can still sum past the terminal height. When that
  // happens, clamp the area so Ink's rendered frame stays below the terminal
  // height and never trips its fullscreen redraw (the "jump to top").
  const clampRows = getLiveAreaClampRows({
    liveItems,
    streamingText: visibleStreamingText,
    columns,
    liveAreaBudget: measuredLiveAreaRows,
  });
  return (
    <ChatLiveArea clampRows={clampRows}>
      {liveItems.map((item, index, items) => (
        <React.Fragment key={item.id}>{renderItem(item, index, items)}</React.Fragment>
      ))}
      <StreamingArea
        isRunning={isRunning}
        streamingText={visibleStreamingText}
        streamingThinking={streamingThinking}
        thinkingMs={thinkingMs}
        reserveSpacing={reserveStreamingSpacing}
        renderMarkdown={renderMarkdown}
        availableTerminalHeight={measuredLiveAreaRows}
        assistantMarginTop={assistantMarginTop}
        continuation={streamingContinuation}
      />
    </ChatLiveArea>
  );
}
