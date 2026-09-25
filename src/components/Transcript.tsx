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
const paceMark = String.raw` ____    _    ____ _____
|  _ \  / \  / ___| ____|
| |_) |/ _ \| |   |  _|
|  __// ___ \ |___| |___
|_|  /_/   \_\____|_____|`;

export function Header({ project, vexState }: { project: string; vexState: "connecting" | "connected" | "failed" }) {
  return <Box flexDirection="column">
    <Text color="greenBright" bold>{paceMark}</Text>
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
