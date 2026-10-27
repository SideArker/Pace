import React from "react";
import { Box } from "ink";
import { ConversationPicker, type ConversationChoice } from "./ConversationMenus.js";
import { QueuedMessages } from "./QueuedMessages.js";
import { UsageBar } from "./UsageBar.js";
import type { UsageLimits } from "../integrations/usage.js";

export type BottomPanelProps = {
  width: number;
  height: number;
  conversations?: {
    choices: ConversationChoice[];
    activeId?: string;
    selectedIndex: number;
    focused: boolean;
    missingProjectPaths?: string[];
    searchQuery?: string;
  };
  showConversations?: boolean;
  pendingInteraction?: boolean;
  queuedPrompts?: readonly string[];
  usageLimits?: UsageLimits;
  usageError?: string;
};

export const TWO_COLUMN_MIN_WIDTH = 78;
export const THREE_COLUMN_MIN_WIDTH = 118;

export function BottomPanel({
  width,
  height,
  conversations,
  showConversations,
  pendingInteraction = false,
  queuedPrompts = [],
  usageLimits,
  usageError,
}: BottomPanelProps) {
  const hasConversations = showConversations ?? (!!conversations && (conversations.choices.length > 1 || conversations.focused));
  const hasQueued = queuedPrompts.length > 0;
  const queuedItems = height < 24 ? 2 : 4;
  // Reserve space for composer, status, panel borders and section headers.
  const conversationItems = pendingInteraction ? 2 : Math.max(2, Math.min(8, Math.floor((height - 12) / 3)));

  const panels: ("conversations" | "queued" | "usage")[] = [];
  if (hasConversations && conversations) panels.push("conversations");
  if (hasQueued) panels.push("queued");
  panels.push("usage");

  const renderPanel = (type: "conversations" | "queued" | "usage", panelWidth: number) => {
    switch (type) {
      case "conversations":
        return conversations ? (
          <ConversationPicker
            key="conversations"
            choices={conversations.choices}
            activeId={conversations.activeId}
            selectedIndex={conversations.selectedIndex}
            focused={conversations.focused}
            missingProjectPaths={conversations.missingProjectPaths}
            searchQuery={conversations.searchQuery}
            width={panelWidth}
            maxItems={conversationItems}
          />
        ) : null;
      case "queued":
        return (
          <QueuedMessages
            key="queued"
            prompts={queuedPrompts}
            width={panelWidth}
            maxItems={queuedItems}
          />
        );
      case "usage":
        return (
          <UsageBar
            key="usage"
            limits={usageLimits}
            error={usageError}
            width={panelWidth}
          />
        );
    }
  };

  // Case 1: Only Usage (full width single panel)
  if (panels.length === 1) {
    return (
      <Box flexDirection="column" width={width} marginTop={1}>
        {renderPanel("usage", width)}
      </Box>
    );
  }

  // Case 2: Two panels (Priority 1/2 + Usage)
  if (panels.length === 2) {
    if (width >= TWO_COLUMN_MIN_WIDTH) {
      const gap = 1;
      const col1Width = Math.floor((width - gap) / 2);
      const col2Width = width - col1Width - gap;
      return (
        <Box flexDirection="row" width={width} gap={gap} marginTop={1}>
          {renderPanel(panels[0]!, col1Width)}
          {renderPanel(panels[1]!, col2Width)}
        </Box>
      );
    }
    return (
      <Box flexDirection="column" width={width} marginTop={1}>
        {renderPanel(panels[0]!, width)}
        {renderPanel(panels[1]!, width)}
      </Box>
    );
  }

  // Case 3: Three panels (Conversations + Queued + Usage)
  if (width >= THREE_COLUMN_MIN_WIDTH) {
    const gap = 1;
    const colWidth = Math.floor((width - gap * 2) / 3);
    const lastWidth = width - colWidth * 2 - gap * 2;
    return (
      <Box flexDirection="row" width={width} gap={gap} marginTop={1}>
        {renderPanel("conversations", colWidth)}
        {renderPanel("queued", colWidth)}
        {renderPanel("usage", lastWidth)}
      </Box>
    );
  }

  // Intermediate width: 2 columns on top, Usage on bottom
  if (width >= TWO_COLUMN_MIN_WIDTH) {
    const gap = 1;
    const col1Width = Math.floor((width - gap) / 2);
    const col2Width = width - col1Width - gap;
    return (
      <Box flexDirection="column" width={width} marginTop={1}>
        <Box flexDirection="row" width={width} gap={gap}>
          {renderPanel("conversations", col1Width)}
          {renderPanel("queued", col2Width)}
        </Box>
        {renderPanel("usage", width)}
      </Box>
    );
  }

  // Narrow terminal: stack vertically
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      {renderPanel("conversations", width)}
      {renderPanel("queued", width)}
      {renderPanel("usage", width)}
    </Box>
  );
}
