import React from "react";
import { Text, Box, useStdout } from "ink";
import { useTheme } from "../theme/theme.js";
import type { PasteInfo } from "./InputArea.js";
import type { PromptSegment } from "../../utils/prompt-enhancer.js";
import {
  getUserMessageDisplayParts,
  getUserMessageTeachingNotes,
} from "../utils/user-message-display.js";

const USER_MESSAGE_PREFIX = "> ";
const USER_MESSAGE_TOP_FILL = "▄";
const USER_MESSAGE_BOTTOM_FILL = "▀";

export function UserMessage({
  text,
  imageCount,
  videoCount,
  pasteInfo,
  enhancements,
}: {
  text: string;
  imageCount?: number;
  videoCount?: number;
  pasteInfo?: PasteInfo;
  /**
   * Ctrl+E prompt-enhancer segments for this message. Honoured only when they
   * still reconstruct `text` exactly, so an edited-after-enhance send renders
   * plain — see `getUserMessageDisplayParts`.
   */
  enhancements?: readonly PromptSegment[];
}) {
  const theme = useTheme();
  const { stdout } = useStdout();

  // This row paints its own dark surface in every theme, so its text comes from
  // the `inputSurface*` tokens rather than the page palette — the light palette
  // is dark-on-white and would be invisible on top of it.
  const surfaceBackground = theme.inputSurface;
  const surfaceText = theme.inputSurfaceText;

  const parts = getUserMessageDisplayParts(text, pasteInfo, enhancements);
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
  const teachingNotes = getUserMessageTeachingNotes(text, pasteInfo, enhancements, messageWidth);

  const renderUserMessageEdge = (fill: string): React.ReactNode => (
    <Box width={messageWidth}>
      <Text color={surfaceBackground}>{fill.repeat(messageWidth)}</Text>
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
        backgroundColor={surfaceBackground}
        width={messageWidth}
      >
        <Box width={USER_MESSAGE_PREFIX.length} flexShrink={0}>
          <Text color={surfaceText} bold backgroundColor={surfaceBackground}>
            {USER_MESSAGE_PREFIX}
          </Text>
        </Box>
        <Box flexGrow={1} backgroundColor={surfaceBackground}>
          <Text wrap="wrap" color={surfaceText} backgroundColor={surfaceBackground}>
            {parts.map((part, index) => (
              <React.Fragment key={index}>
                {part.separated && index > 0 ? (
                  <Text color={surfaceText} backgroundColor={surfaceBackground}>
                    {" "}
                  </Text>
                ) : null}
                <Text
                  color={part.kind === "term" ? theme.inputSurfaceAccent : surfaceText}
                  bold={part.kind === "term"}
                  underline={part.kind === "term"}
                  dimColor={part.kind === "paste"}
                  backgroundColor={surfaceBackground}
                >
                  {part.text}
                </Text>
              </React.Fragment>
            ))}
            {mediaLabels.map((label) => (
              <Text
                key={label}
                color={theme.inputSurfaceAccent}
                backgroundColor={surfaceBackground}
              >
                {` ${label}`}
              </Text>
            ))}
          </Text>
        </Box>
      </Box>
      {renderUserMessageEdge(USER_MESSAGE_BOTTOM_FILL)}
      {teachingNotes.map((note) => (
        <Text key={note} color={theme.textDim}>
          {note}
        </Text>
      ))}
    </Box>
  );
}
