import React from "react";
import { Box, Text } from "ink";
import { EFFORTS } from "../config.js";
import type { Config, Session } from "../types.js";

export function ModelMenu({ mode, models, selectedModel, selectedIndex, config }: { mode: "models" | "efforts"; models: string[]; selectedModel: string; selectedIndex: number; config?: Config }) {
  return <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
    <Text color="greenBright" bold>{mode === "models" ? "Models" : `${selectedModel} reasoning levels`}</Text>
    {(mode === "models" ? models : EFFORTS).map((item, index) => {
      const configured = config?.models.find(model => model.model === (mode === "models" ? item : selectedModel));
      const enabled = mode === "models" ? !!configured && configured.enabled !== false : !!configured?.efforts.includes(item as typeof EFFORTS[number]);
      return <Text key={item} color={index === selectedIndex ? "cyanBright" : undefined}>
        {index === selectedIndex ? "› " : "  "}{enabled ? "[x]" : "[ ]"} {item}{mode === "models" && configured ? ` · ${configured.efforts.join(", ")}` : ""}
      </Text>;
    })}
    <Text color="gray">{mode === "models" ? "↑/↓ or Tab select · Space toggle · Enter edit reasoning · Esc close" : "↑/↓ or Tab select · Space/Enter toggle · Esc models"}</Text>
  </Box>;
}

export function ResumeMenu({ choices, selectedIndex }: { choices: Session[]; selectedIndex: number }) {
  return <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
    <Text color="greenBright" bold>Conversations</Text>
    {choices.map((choice, index) => <Text key={choice.id} color={index === selectedIndex ? "cyanBright" : undefined}>
      {index === selectedIndex ? "› " : "  "}{choice.id.slice(0, 8)} · {choice.updatedAt.slice(0, 16)} · {choice.turns.at(-1)?.prompt ?? "(empty)"}
    </Text>)}
    <Text color="gray">↑/↓ or Tab select · Enter resume · Esc close</Text>
  </Box>;
}

export function CommandMenu({ matches, selectedIndex }: { matches: string[]; selectedIndex: number }) {
  return <Box flexDirection="column">
    <Text color="gray">Commands · ↑/↓ select · Tab complete</Text>
    {matches.map((match, index) => <Text key={match} color={index === selectedIndex ? "cyanBright" : undefined}>{index === selectedIndex ? "› " : "  "}{match}</Text>)}
  </Box>;
}
