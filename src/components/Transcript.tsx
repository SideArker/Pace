import React from "react";
import { Box, Text } from "ink";
import { MarkdownText } from "./TranscriptMarkdown.js";
export { Header } from "./Header.js";
export { letterGradients } from "./Header.js";

export type Line = {
  id: number;
  role:
    | "you"
    | "codex"
    | "side"
    | "info"
    | "system"
    | "meta"
    | "error"
    | "artifact"
    | "divider"
    | "activity";
  text: string;
  spaceBefore: boolean;
  activity?: {
    category: "thinking" | "command" | "files" | "tool" | "search" | "plan";
    detail?: string;
    completed: boolean;
  };
  sourceId?: string;
};

// Ink can only append settled lines to terminal history. Keep running activity
// live, along with later lines that may still need to be redrawn.
export function splitTranscript(lines: Line[]): { history: Line[][]; live: Line[] } {
  let settledEnd = lines.findIndex(line => line.activity && !line.activity.completed);
  if (settledEnd < 0) settledEnd = lines.length;
  while (settledEnd > 0 && lines[settledEnd - 1]?.activity?.category === "thinking") settledEnd--;

  const history: Line[][] = [];
  for (const line of lines.slice(0, settledEnd)) {
    const group = history.at(-1);
    if (line.activity?.category === "thinking" && group?.[0]?.activity?.category === "thinking") group.push(line);
    else history.push([line]);
  }
  return { history, live: lines.slice(settledEnd) };
}

const activityColors = {
  thinking: "magentaBright",
  command: "#38BDF8",
  files: "yellow",
  tool: "blueBright",
  search: "blue",
  plan: "magenta",
} as const;

const activityIcons = {
  thinking: "✧",
  command: "</>",
  files: "◇",
  tool: "⚙",
  search: "🔍",
  plan: "📋",
} as const;

function activityTitle(line: Line): string {
  if (line.activity?.category === "command") {
    return line.text.replace(/^(?:Running|Ran): /, "");
  }
  return line.text;
}

function activityIcon(line: Line): string {
  return line.activity?.category === "command" && /^(?:(?:Running|Ran|Failed): )?PS \(PowerShell\):/.test(line.text)
    ? ">_"
    : activityIcons[line.activity!.category];
}

function DiffDetail({ detail, livePreview }: { detail: string; livePreview: boolean }) {
  const lines = detail.slice(-12000).split("\n");
  return <Box flexDirection="column">{(livePreview ? lines.slice(-2) : lines).map((line, index) => (
    <Text key={index} color={line.startsWith("+") && !line.startsWith("+++") ? "#34D399" : line.startsWith("-") && !line.startsWith("---") ? "#F87171" : "#94A3B8"} wrap={livePreview ? "truncate" : "wrap"}>{line || " "}</Text>
  ))}</Box>;
}

export function Transcript({
  lines,
  outputsExpanded,
  detailsExpanded,
  livePreview = false,
  width = 80,
}: {
  lines: Line[];
  outputsExpanded: boolean;
  detailsExpanded: boolean;
  livePreview?: boolean;
  width?: number;
}) {
  const displayLines: (Line & { thinkingCount?: number })[] = [];
  for (const line of lines) {
    const previous = displayLines.at(-1);
    if (line.activity?.category === "thinking" && previous?.activity?.category === "thinking") {
      displayLines[displayLines.length - 1] = {
        ...previous,
        sourceId: line.sourceId,
        thinkingCount: (previous.thinkingCount ?? 1) + 1,
        activity: {
          ...line.activity,
          detail: [previous.activity.detail, line.activity.detail].filter(Boolean).join("\n\n") || undefined,
        },
      };
    } else {
      displayLines.push(line);
    }
  }
  const dividerLength = Math.max(20, Math.min(width - 4, 72));

  return (
    <Box flexDirection="column">
      {displayLines.map((line) => (
        <Box
          key={line.id}
          flexDirection="column"
          marginTop={line.spaceBefore ? 1 : 0}
        >
          {line.role === "you" ? (
            <Box gap={1}>
              <Text color="#38BDF8" bold>
                ❯ You
              </Text>
              <Box flexShrink={1}>
                <MarkdownText source={line.text} color="white" />
              </Box>
            </Box>
          ) : line.role === "codex" ? (
            <Box gap={1}>
              <Text color="#59E6A7" bold>
                ◆ Pace
              </Text>
              <Box flexShrink={1}>
                <MarkdownText source={line.text} />
              </Box>
            </Box>
          ) : line.role === "side" ? (
            <Box gap={1}>
              <Text color="#E879F9" bold>
                ◇ Btw{" "}
              </Text>
              <Box flexShrink={1}>
                <MarkdownText source={line.text} color="#F5D0FE" />
              </Box>
            </Box>
          ) : line.role === "activity" && line.activity ? (
            <Box flexDirection="column">
              <Box gap={1} marginLeft={line.activity.category === "command" ? 0 : 1}>
                <Text wrap={line.activity.category === "command" ? "truncate" : undefined} color={line.activity.category === "command" ? activityColors.command : line.activity.completed ? "#64748B" : activityColors[line.activity.category]} bold={line.activity.category === "command"}>
                  {line.activity.completed ? " " : "◌"} {activityIcon(line)} {activityTitle(line)}{line.thinkingCount ? ` · ${line.thinkingCount} thoughts` : ""}
                </Text>
                {line.activity.detail && line.activity.category !== "files" ? (
                  <Text dimColor>
                    {(
                      line.activity.category === "command"
                        ? outputsExpanded
                        : detailsExpanded
                    )
                      ? "▾"
                      : "▸"}
                  </Text>
                ) : null}
              </Box>
              {line.activity.detail &&
              (line.activity.category === "files" || (line.activity.category === "command"
                ? outputsExpanded
                : detailsExpanded)) ? (
                <Box
                  marginLeft={2}
                  paddingLeft={1}
                  borderStyle="single"
                  borderLeft
                  borderRight={false}
                  borderTop={false}
                  borderBottom={false}
                  borderColor="#475569"
                >
                  {line.activity.category === "files"
                    ? <DiffDetail detail={line.activity.detail} livePreview={livePreview} />
                    : <Text color="gray" wrap={livePreview ? "truncate" : "wrap"}>{livePreview ? line.activity.detail.slice(-500).split("\n").slice(-2).join("\n") : line.activity.detail.slice(-12000)}</Text>}
                </Box>
              ) : null}
            </Box>
          ) : line.role === "divider" ? (
            <Text color="#334155">{"─".repeat(dividerLength)}</Text>
          ) : line.role === "meta" ? (
            <Box marginLeft={1}>
              <Text color="#64748B">{line.text}</Text>
            </Box>
          ) : line.role === "artifact" ? (
            <Box gap={1}>
              <Text color="#C084FC" bold>
                📦 Artifact:
              </Text>
              <Text color="#DDD6FE" underline>
                {line.text}
              </Text>
            </Box>
          ) : line.role === "error" ? (
            <Box gap={1}>
              <Text color="#F87171" bold>
                ✖ Pace:
              </Text>
              <Box flexShrink={1}>
                <MarkdownText source={line.text} color="#EF4444" />
              </Box>
            </Box>
          ) : line.role === "system" ? (
            <Box gap={1}>
              <Text color="#A78BFA" bold>◆ System</Text>
              <Text color="#C4B5FD">{line.text}</Text>
            </Box>
          ) : (
            <Text color="gray">{line.text}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
