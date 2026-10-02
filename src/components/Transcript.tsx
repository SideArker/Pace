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
    outcome?: "success" | "failure";
    startedAt?: number;
    durationMs?: number;
    tokens?: number;
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

function activityTitle(line: Line): string {
  const activity = line.activity!;
  const text = line.text.replace(/^(?:Running|Ran|Failed): /, "");
  if (activity.category === "thinking") {
    const duration = activity.durationMs ?? (activity.startedAt ? Date.now() - activity.startedAt : undefined);
    return `Thought${duration === undefined ? "" : ` for ${Math.max(0, Math.round(duration / 100) / 10)} seconds`}${activity.tokens === undefined ? "" : `, ${activity.tokens} tokens`}`;
  }
  if (activity.category === "command") {
    const command = text.replace(/ \(exit [^)]+\)$/, "");
    const shell = /^(?:PS \(PowerShell\)|PS): ([\s\S]*)$/.exec(command);
    const bash = /^Bash: ([\s\S]*)$/.exec(command);
    const body = shell?.[1] ?? bash?.[1] ?? command;
    const read = /^(?:cat|head|tail)\s+([^|;&]+)$/.exec(body);
    if (read && !read[1]!.trim().startsWith("-")) return `Read(${read[1]!.trim()})`;
    return `${shell ? "PS" : "Bash"}(${body})`;
  }
  if (activity.category === "files") return `Edit(${text.replace(/^(?:Edited|Failed to edit)\s+/, "")})`;
  if (activity.category === "search") return `Search(${text.replace(/^Web search:\s*/, "")})`;
  if (activity.category === "tool") return /^(?:Read|Edit|Bash|Search|Tool)\(/.test(text) ? text : `Tool(${text.replace(/^Tool\s+/, "").replace(/:\s*(?:in_progress|completed|failed)$/, "")})`;
  return text;
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
          startedAt: previous.activity.startedAt,
          durationMs: previous.activity.durationMs === undefined && line.activity.durationMs === undefined ? undefined : (previous.activity.durationMs ?? 0) + (line.activity.durationMs ?? 0),
          tokens: previous.activity.tokens === undefined && line.activity.tokens === undefined ? undefined : (previous.activity.tokens ?? 0) + (line.activity.tokens ?? 0),
        },
      };
    } else {
      displayLines.push(line);
    }
  }
  const dividerLength = Math.max(20, Math.min(width - 4, 72));
  const expanded = outputsExpanded || detailsExpanded;
  const preview = livePreview && !expanded;

  return (
    <Box flexDirection="column" width={width}>
      {displayLines.map((line) => (
        <Box
          key={line.id}
          flexDirection="column"
          marginTop={line.spaceBefore ? 1 : 0}
          width={width}
        >
          {line.role === "you" ? (
            <Box gap={1} width={width}>
              <Box flexShrink={0}>
                <Text color="#38BDF8" bold>
                  ❯ You
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <MarkdownText source={line.text} color="white" />
              </Box>
            </Box>
          ) : line.role === "codex" ? (
            <Box gap={1} width={width}>
              <Box flexShrink={0}>
                <Text color="#59E6A7" bold>
                  ◆ Pace
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <MarkdownText source={line.text} />
              </Box>
            </Box>
          ) : line.role === "side" ? (
            <Box gap={1} width={width}>
              <Box flexShrink={0}>
                <Text color="#E879F9" bold>
                  ◇ Btw{" "}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <MarkdownText source={line.text} color="#F5D0FE" />
              </Box>
            </Box>
          ) : line.role === "activity" && line.activity ? (
            <Box flexDirection="column" width={width}>
              <Box gap={1} width={width}>
                <Box flexShrink={0}>
                  <Text color={!line.activity.completed ? "#64748B" : line.activity.outcome === "failure" ? "#F87171" : "#59E6A7"}>{line.activity.completed ? "■" : "□"}</Text>
                </Box>
                <Box flexShrink={1}>
                  <Text wrap={line.activity.category === "command" ? "truncate" : undefined} color={activityColors[line.activity.category]} bold={line.activity.category === "command"}>
                    ◆ {activityTitle(line)}
                  </Text>
                </Box>
                {line.activity.detail ? (
                  <Box flexShrink={0}>
                    <Text dimColor>
                      {expanded ? "▾" : "▸"}
                    </Text>
                  </Box>
                ) : null}
              </Box>
              {line.activity.detail &&
              expanded ? (
                <Box
                  marginLeft={2}
                  paddingLeft={1}
                  borderStyle="single"
                  borderLeft
                  borderRight={false}
                  borderTop={false}
                  borderBottom={false}
                  borderColor="#475569"
                  width={width ? Math.max(10, width - 2) : undefined}
                >
                  {line.activity.category === "files"
                    ? <DiffDetail detail={line.activity.detail} livePreview={preview} />
                    : <Text color="gray" wrap={preview ? "truncate" : "wrap"}>{preview ? line.activity.detail.slice(-500).split("\n").slice(-2).join("\n") : line.activity.detail.slice(-12000)}</Text>}
                </Box>
              ) : null}
            </Box>
          ) : line.role === "divider" ? (
            <Text color="#334155">{"─".repeat(dividerLength)}</Text>
          ) : line.role === "meta" ? (
            <Box marginLeft={1} width={width ? Math.max(10, width - 1) : undefined}>
              <Text color="#64748B">{line.text}</Text>
            </Box>
          ) : line.role === "artifact" ? (
            <Box gap={1} width={width}>
              <Box flexShrink={0}>
                <Text color="#C084FC" bold>
                  📦 Artifact:
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color="#DDD6FE" underline wrap="truncate">
                  {line.text}
                </Text>
              </Box>
            </Box>
          ) : line.role === "error" ? (
            <Box gap={1} width={width}>
              <Box flexShrink={0}>
                <Text color="#F87171" bold>
                  ✖ Pace:
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <MarkdownText source={line.text} color="#EF4444" />
              </Box>
            </Box>
          ) : line.role === "system" ? (
            <Box gap={1} width={width}>
              <Box flexShrink={0}>
                <Text color="#A78BFA" bold>◆ System</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color="#C4B5FD">{line.text}</Text>
              </Box>
            </Box>
          ) : (
            <Box width={width}>
              <Text color="gray">{line.text}</Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
