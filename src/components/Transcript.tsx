import React from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";

export type Line = {
  id: number;
  role: "you" | "codex" | "side" | "info" | "meta" | "error" | "artifact" | "divider" | "activity";
  text: string;
  spaceBefore: boolean;
  activity?: { category: "thinking" | "command" | "files" | "tool" | "search" | "plan"; detail?: string; completed: boolean };
  sourceId?: string;
};

const colors = { thinking: "magentaBright", command: "cyan", files: "yellow", tool: "blueBright", search: "blue", plan: "magenta" } as const;
const paceMark = [
  { color: "#46E6A7", lines: ["  ______  ", " /  __  \\", "|  |__) |", "|  ____/ ", "|  |     ", "|__|     "] },
  { color: "#25D9CD", lines: ["   ____    ", "  / __ \\   ", " / /__\\ \\  ", "|  ____  | ", "| |    | | ", "|_|    |_| "] },
  { color: "#36BDF2", lines: ["  ______  ", " /  ____|", "|  |     ", "|  |     ", "|  |____ ", " \\______|"] },
  { color: "#9BA9FF", lines: [" ________ ", "|  ______|", "|  |___   ", "|   ___|  ", "|  |_____ ", "|________|"] },
] as const;
const compactMark = String.raw` ____    _    ____ _____
|  _ \  / \  / ___| ____|
| |_) |/ _ \| |   |  _|
|  __// ___ \ |___| |___
|_|  /_/   \_\____|_____|`;

export function Header({ project, vexState, width }: { project: string; vexState: "connecting" | "connected" | "failed"; width: number }) {
  const wide = width >= 52;
  return <Box flexDirection="column">
    {wide
      ? <Box gap={2}>{paceMark.map(({ color, lines }) => <Text key={color} color={color} bold>{lines.join("\n")}</Text>)}</Box>
      : <Text color="greenBright" bold>{compactMark}</Text>}
    {wide ? <Text color="gray">{"// "}<Text color="cyan">CODE IN MOTION</Text>{" ".repeat(2)}{"-".repeat(26)}{" >"}</Text> : null}
    <Box gap={2} marginLeft={1}><Text color="gray">{basename(project)}</Text><Text color={vexState === "connected" ? "green" : vexState === "failed" ? "red" : "yellow"}>Vex MCP {vexState === "connected" ? "connected" : vexState === "failed" ? "unavailable" : "connecting"}</Text></Box>
  </Box>;
}

export function Transcript({ lines, outputsExpanded, detailsExpanded, rows, scrollBack }: { lines: Line[]; outputsExpanded: boolean; detailsExpanded: boolean; rows: number; scrollBack: number }) {
  // Keep the transcript in Ink's redraw area so old entries can actually disappear or collapse.
  const count = Math.max(8, rows - 12);
  const end = Math.max(0, lines.length - scrollBack);
  const visible = lines.slice(Math.max(0, end - count), end);
  return <Box flexDirection="column">
    {scrollBack > 0 ? <Text color="gray">↑ Earlier activity · PageDown to return</Text> : null}
    {visible.map(line => <Box key={line.id} flexDirection="column" marginTop={line.spaceBefore ? 1 : 0}>
      {line.role === "you" ? <><Text color="cyanBright" bold>You</Text><Text>{line.text}</Text></>
      : line.role === "codex" ? <><Text color="greenBright" bold>Pace</Text><Text>{line.text}</Text></>
      : line.role === "side" ? <><Text color="magentaBright" bold>Btw</Text><Text>{line.text}</Text></>
      : line.role === "activity" && line.activity ? <>
        <Text color={colors[line.activity.category]}>{line.activity.completed ? "◆" : "◇"} {line.text}{line.activity.detail ? `  ${(line.activity.category === "command" ? outputsExpanded : detailsExpanded) ? "▾" : "▸"}` : ""}</Text>
        {line.activity.detail && (line.activity.category === "command" ? outputsExpanded : detailsExpanded) ? <Text color="gray">{line.activity.detail.slice(-12000)}</Text> : null}
      </>
      : line.role === "divider" ? <Text color="gray">{"─".repeat(42)}</Text>
      : line.role === "meta" ? <Text color="gray">{line.text}</Text>
      : line.role === "artifact" ? <Text color="magenta">Artifact: {line.text}</Text>
      : line.role === "error" ? <Text color="red">Pace: {line.text}</Text>
      : <Text color="gray">{line.text}</Text>}
    </Box>)}
  </Box>;
}
