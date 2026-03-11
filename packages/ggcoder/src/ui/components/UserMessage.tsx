import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import type { PasteInfo } from "./InputArea.js";

export function UserMessage({
  text,
  imageCount,
  pasteInfo,
}: {
  text: string;
  imageCount?: number;
  pasteInfo?: PasteInfo;
}) {
  const theme = useTheme();

  // Use precise paste boundaries when available
  const hasPaste = pasteInfo != null && pasteInfo.length > 0;
  const typedBefore = hasPaste ? text.slice(0, pasteInfo.offset) : "";
  const typedAfter = hasPaste ? text.slice(pasteInfo.offset + pasteInfo.length) : "";
  const badge = hasPaste ? `[Pasted text #${pasteInfo.length} +${pasteInfo.lineCount} lines]` : "";

  return (
    <Box marginTop={1} flexDirection="column">
      <Box paddingX={1} paddingY={0}>
        <Text wrap="wrap" color="white" backgroundColor="gray">
          <Text color={theme.inputPrompt} backgroundColor="gray">
            {"❯ "}
          </Text>
          {hasPaste ? (
            <>
              {typedBefore && <Text backgroundColor="gray">{typedBefore} </Text>}
              <Text dimColor backgroundColor="gray">
                {badge}
              </Text>
              {typedAfter && <Text backgroundColor="gray"> {typedAfter}</Text>}
            </>
          ) : (
            text
          )}
          {imageCount != null &&
            imageCount > 0 &&
            Array.from({ length: imageCount }, (_, i) => (
              <Text key={i} color={theme.accent} backgroundColor="gray">
                {" "}
                [Image #{i + 1}]
              </Text>
            ))}
        </Text>
      </Box>
    </Box>
  );
}
