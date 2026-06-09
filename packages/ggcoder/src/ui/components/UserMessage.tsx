import React from "react";
import { Text, Box, useStdout } from "ink";
import { useTheme } from "../theme/theme.js";
import type { PasteInfo } from "./InputArea.js";
import { getUserMessageDisplayParts } from "../utils/user-message-display.js";

const USER_MESSAGE_BACKGROUND = "#374151";
const USER_MESSAGE_PREFIX = "> ";
const USER_MESSAGE_TOP_FILL = "▄";
const USER_MESSAGE_BOTTOM_FILL = "▀";

export function UserMessage({
  text,
  imageCount,
  videoCount,
  pasteInfo,
}: {
  text: string;
  imageCount?: number;
  videoCount?: number;
  pasteInfo?: PasteInfo;
}) {
  const theme = useTheme();
  const { stdout } = useStdout();

  const parts = getUserMessageDisplayParts(text, pasteInfo);
  const imageLabels =
    imageCount != null && imageCount > 0
      ? Array.from({ length: imageCount }, (_, i) => `[Image #${i + 1}]`)
      : [];
  const videoLabels =
    videoCount != null && videoCount > 0
      ? Array.from({ length: videoCount }, (_, i) => `[Video #${i + 1}]`)
      : [];
  const mediaLabels = [...imageLabels, ...videoLabels];
  const messageWidth = Math.max(1, stdout.columns ?? 80);

  const renderUserMessageEdge = (fill: string): React.ReactNode => (
    <Box width={messageWidth}>
      <Text color={USER_MESSAGE_BACKGROUND}>{fill.repeat(messageWidth)}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" width={messageWidth} flexGrow={0} flexShrink={0}>
      {renderUserMessageEdge(USER_MESSAGE_TOP_FILL)}
      <Box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        flexGrow={0}
        flexShrink={0}
        backgroundColor={USER_MESSAGE_BACKGROUND}
        width={messageWidth}
      >
        <Box width={USER_MESSAGE_PREFIX.length} flexShrink={0}>
          <Text color={theme.commandColor} bold backgroundColor={USER_MESSAGE_BACKGROUND}>
            {USER_MESSAGE_PREFIX}
          </Text>
        </Box>
        <Box flexGrow={1} backgroundColor={USER_MESSAGE_BACKGROUND}>
          <Text wrap="wrap" color={theme.commandColor} backgroundColor={USER_MESSAGE_BACKGROUND}>
            {parts.map((part, index) => (
              <React.Fragment key={index}>
                {index > 0 ? (
                  <Text color={theme.commandColor} backgroundColor={USER_MESSAGE_BACKGROUND}>
                    {" "}
                  </Text>
                ) : null}
                <Text
                  color={theme.commandColor}
                  dimColor={part.kind === "paste"}
                  backgroundColor={USER_MESSAGE_BACKGROUND}
                >
                  {part.text}
                </Text>
              </React.Fragment>
            ))}
            {mediaLabels.map((label) => (
              <Text key={label} color={theme.accent} backgroundColor={USER_MESSAGE_BACKGROUND}>
                {` ${label}`}
              </Text>
            ))}
          </Text>
        </Box>
      </Box>
      {renderUserMessageEdge(USER_MESSAGE_BOTTOM_FILL)}
    </Box>
  );
}
