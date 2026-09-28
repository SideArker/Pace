import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getGitBranch } from "../core/system/git.js";

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

type MarkdownRun = { text: string; color?: string; bold?: boolean; italic?: boolean; underline?: boolean; dimColor?: boolean; code?: boolean; url?: string };

function terminalLinkTarget(destination: string): string | undefined {
  const href = destination.startsWith("<") && destination.endsWith(">") ? destination.slice(1, -1) : destination;
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
    try {
      const url = new URL(href);
      return ["http:", "https:", "mailto:", "file:"].includes(url.protocol) ? url.href : undefined;
    } catch { return undefined; }
  }
  return pathToFileURL(resolve(process.cwd(), href)).href;
}

function terminalLink(text: string, destination: string): string {
  const target = terminalLinkTarget(destination);
  return target ? `\u001b]8;;${target}\u001b\\${text}\u001b]8;;\u001b\\` : text;
}

function markdownRuns(source: string): MarkdownRun[] {
  const runs: MarkdownRun[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|\[[^\]]+\]\((?:<[^>]+>|(?:[^()]|\([^()]*\))+?)\))/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > offset) runs.push({ text: source.slice(offset, index) });
    const token = match[0];
    if (token.startsWith("`")) runs.push({ text: token.slice(1, -1), code: true, color: "#FBBF24" });
    else if (token.startsWith("**") || token.startsWith("__")) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith("~~")) runs.push({ text: token.slice(2, -2), dimColor: true });
    else if (token.startsWith("*") || token.startsWith("_")) runs.push({ text: token.slice(1, -1), italic: true });
    else {
      const link = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!;
      runs.push({ text: `${link[1]} (${link[2]})`, color: "#38BDF8", underline: true, url: link[2] });
    }
    offset = index + token.length;
  }
  if (offset < source.length) runs.push({ text: source.slice(offset) });
  return runs.length ? runs : [{ text: source }];
}

function MarkdownText({ source, color }: { source: string; color?: string }) {
  const fenced = source.startsWith("```");
  if (fenced) {
    const code = source.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
    return <Text color="#FBBF24">{code}</Text>;
  }
  const heading = /^(#{1,6})\s+(.+)$/.exec(source);
  const list = /^(\s*)([-*+] |\d+\. )(.*)$/.exec(source);
  const quote = /^>\s?(.*)$/.exec(source);
  const body = heading?.[2] ?? list?.[3] ?? quote?.[1] ?? source;
  const prefix = heading ? "" : list ? `${list[1]}${/^\d/.test(list[2]!) ? list[2] : "• "}` : quote ? "│ " : "";
  const colorForText = heading ? "#A7F3D0" : quote ? "#94A3B8" : color;
  return <Text color={colorForText} bold={!!heading}>{prefix}{markdownRuns(body).map((run, index) => <Text key={index} color={run.color ?? colorForText} bold={run.bold} italic={run.italic} underline={run.underline} dimColor={run.dimColor}>{run.code ? <Text backgroundColor="#1E293B">{run.text}</Text> : run.url ? terminalLink(run.text, run.url) : run.text}</Text>)}</Text>;
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

function DiffDetail({ detail }: { detail: string }) {
  return <Box flexDirection="column">{detail.slice(-12000).split("\n").map((line, index) => (
    <Text key={index} color={line.startsWith("+") && !line.startsWith("+++") ? "#34D399" : line.startsWith("-") && !line.startsWith("---") ? "#F87171" : "#94A3B8"} wrap="wrap">{line || " "}</Text>
  ))}</Box>;
}

const paceShadowLetters = [
  ["  ██████╗ ", "  █████╗ ", "  ██████╗ ", "███████╗"],
  ["  ██╔══██╗", " ██╔══██╗", " ██╔════╝ ", "██╔════╝"],
  ["  ██████╔╝", " ███████║", " ██║      ", "█████╗  "],
  ["  ██╔═══╝ ", " ██╔══██║", " ██║      ", "██╔══╝  "],
  ["  ██║     ", " ██║  ██║", " ╚██████╗ ", "███████╗"],
  ["  ╚═╝     ", " ╚═╝  ╚═╝", "  ╚═════╝ ", "╚══════╝"],
] as const;

const paceMicroLetters = [
  ["  █▀█ ", "▄▀█ ", "█▀▀ ", "█▀▀"],
  ["  █▀▀ ", "█▀█ ", "█▄▄ ", "██▄"],
] as const;

export const letterGradients = ["#59E6A7", "#4ADE80", "#2DD4BF", "#38BDF8"] as const;

export function Header({
  project,
  vexState,
  width,
}: {
  project: string;
  vexState: "connecting" | "connected" | "failed";
  width: number;
}) {
  const branch = useMemo(() => getGitBranch(project), [project]);
  const dividerLength = Math.max(20, Math.min(width - 4, 72));

  return (
    <Box flexDirection="column" marginBottom={1}>
      {width >= 42 ? (
        <Box flexDirection="column">
          {paceShadowLetters.map((row, rIdx) => (
            <Box key={rIdx}>
              {row.map((letter, lIdx) => (
                <Text key={lIdx} color={letterGradients[lIdx]} bold>
                  {letter}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : width >= 24 ? (
        <Box flexDirection="column">
          {paceMicroLetters.map((row, rIdx) => (
            <Box key={rIdx}>
              {row.map((letter, lIdx) => (
                <Text key={lIdx} color={letterGradients[lIdx]} bold>
                  {letter}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : (
        <Text color="#59E6A7" bold>
          ⚡ PACE
        </Text>
      )}

      <Box gap={1} marginTop={1} flexWrap="wrap">
        <Text color="#A7F3D0" bold>
          📁 {basename(project)}
        </Text>
        {branch ? <Text color="#93C5FD">⎇ {branch}</Text> : null}
        <Text
          color={
            vexState === "connected"
              ? "#34D399"
              : vexState === "failed"
                ? "#F87171"
                : "#FBBF24"
          }
        >
          {vexState === "connected"
            ? "● Vex MCP connected"
            : vexState === "failed"
              ? "⨯ Vex MCP unavailable"
              : "◌ Vex MCP connecting..."}
        </Text>
      </Box>

      <Box marginTop={0}>
        <Text dimColor>Type </Text>
        <Text color="#38BDF8" bold>
          /help
        </Text>
        <Text dimColor> for commands · </Text>
        <Text color="#38BDF8" bold>
          !cmd
        </Text>
        <Text dimColor> for bash · </Text>
        <Text color="#38BDF8" bold>
          /models
        </Text>
        <Text dimColor> for routing</Text>
      </Box>

      <Box marginTop={0}>
        <Text color="#334155">{"─".repeat(dividerLength)}</Text>
      </Box>
    </Box>
  );
}

export function Transcript({
  lines,
  outputsExpanded,
  detailsExpanded,
  rows,
  scrollBack,
  width = 80,
}: {
  lines: Line[];
  outputsExpanded: boolean;
  detailsExpanded: boolean;
  rows: number;
  scrollBack: number;
  width?: number;
}) {
  // Keep Ink's redraw area within one terminal screen; scroll through the
  // transcript by changing its end offset instead of rendering a huge buffer.
  const count = Math.max(1, rows - 12);
  const end = Math.max(0, lines.length - scrollBack);
  const visible = lines.slice(Math.max(0, end - count), end);
  const displayLines: (Line & { thinkingCount?: number })[] = [];
  for (const line of visible) {
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
      {scrollBack > 0 ? (
        <Text color="#94A3B8">↑ Earlier activity · PageDown to return</Text>
      ) : null}
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
              <Box gap={1} marginLeft={1}>
                <Text color={line.activity.category === "command" ? activityColors.command : line.activity.completed ? "#64748B" : activityColors[line.activity.category]} bold={line.activity.category === "command"}>
                  {line.activity.completed ? " " : "◌"} {activityIcons[line.activity.category]} {activityTitle(line)}{line.thinkingCount ? ` · ${line.thinkingCount} thoughts` : ""}
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
                    ? <DiffDetail detail={line.activity.detail} />
                    : <Text color="gray" wrap="wrap">{line.activity.detail.slice(-12000)}</Text>}
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
