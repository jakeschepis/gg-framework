import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { BLACK_CIRCLE } from "../constants/figures.js";
import { HOOK_TONE_COLOR, type HookTone } from "../app-items.js";

interface IdealHookMessageProps {
  text: string;
  tone?: HookTone;
}

// Mirror AssistantMessage's layout so the row lines up with normal assistant
// output — same left padding, same prefix width, same content width.
const RESPONSE_LEFT_PADDING = 1;
const RESPONSE_RIGHT_GUARD = 1;
// BLACK_CIRCLE + " " = 2 chars.
const PREFIX_WIDTH = 2;

/**
 * Announces that the automatic ideal-review hook engaged before the final
 * response. Styled like an assistant message (dot prefix, padding, spacing)
 * but in the theme's secondary color so it stands out from normal output.
 */
export const IdealHookMessage = React.memo(function IdealHookMessage({
  text,
  tone = "review",
}: IdealHookMessageProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const contentWidth = Math.max(
    10,
    columns - RESPONSE_LEFT_PADDING - PREFIX_WIDTH - RESPONSE_RIGHT_GUARD,
  );
  const toneColor = theme[HOOK_TONE_COLOR[tone]];

  return (
    <Box flexDirection="row" paddingLeft={RESPONSE_LEFT_PADDING} flexShrink={1}>
      <Box width={PREFIX_WIDTH} flexShrink={0}>
        <Text color={toneColor}>{BLACK_CIRCLE + " "}</Text>
      </Box>
      <Box width={contentWidth} flexShrink={1}>
        <Text color={toneColor} bold>
          {text}
        </Text>
      </Box>
    </Box>
  );
});
