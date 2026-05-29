import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme/theme.js";
import { stripTerminalFocusSequences } from "../utils/terminal-input.js";

interface SelectListItem {
  label: string;
  value: string;
  description?: string;
}

interface SelectListProps {
  items: SelectListItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  initialIndex?: number;
  /** If set, render at most this many items at once and scroll the window as the selection moves. */
  windowSize?: number;
}

export function SelectList({
  items,
  onSelect,
  onCancel,
  initialIndex = 0,
  windowSize,
}: SelectListProps) {
  const theme = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter) return items;
    const lower = filter.toLowerCase();
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(lower) || item.value.toLowerCase().includes(lower),
    );
  }, [items, filter]);

  useInput((input, key) => {
    const inputWithoutFocusReports = stripTerminalFocusSequences(input);
    if (!inputWithoutFocusReports && input) return;
    input = inputWithoutFocusReports;

    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      if (filtered.length > 0) {
        onSelect(filtered[selectedIndex].value);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }

    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setFilter((f) => f + input);
      setSelectedIndex(0);
    }
  });

  const total = filtered.length;
  const clampedIndex = Math.min(Math.max(selectedIndex, 0), Math.max(0, total - 1));
  const useWindow = windowSize !== undefined && windowSize > 0 && total > windowSize;
  const start = useWindow
    ? Math.max(0, Math.min(clampedIndex - Math.floor(windowSize / 2), total - windowSize))
    : 0;
  const end = useWindow ? Math.min(start + windowSize, total) : total;
  const visible = useWindow ? filtered.slice(start, end) : filtered;
  const hasAbove = useWindow && start > 0;
  const hasBelow = useWindow && end < total;

  return (
    <Box flexDirection="column">
      {filter && (
        <Box marginBottom={1}>
          <Text color={theme.textDim}>Filter: {filter}</Text>
        </Box>
      )}
      {hasAbove && <Text color={theme.textDim}> ↑ {start} more</Text>}
      {visible.map((item, i) => {
        const index = useWindow ? start + i : i;
        return (
          <Box key={item.value}>
            <Text color={index === clampedIndex ? theme.primary : theme.text}>
              {index === clampedIndex ? "❯ " : "  "}
              {item.label}
            </Text>
            {item.description && <Text color={theme.textDim}> — {item.description}</Text>}
          </Box>
        );
      })}
      {hasBelow && <Text color={theme.textDim}> ↓ {total - end} more</Text>}
      {filtered.length === 0 && <Text color={theme.textDim}>No matches</Text>}
      <Box marginTop={1}>
        <Text color={theme.textDim}>↑↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
