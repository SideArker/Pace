import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { COLOR_SCHEMES, getTheme } from "../shared/colors.js";
import type { ApprovalMode, Config } from "../shared/types.js";
import { PanelFrame } from "./PanelFrame.js";
import { menuWindow } from "./conversation-menu-utils.js";

const approvals: { id: ApprovalMode; description: string }[] = [
  { id: "request-approval", description: "Sandboxed turns; ask for risky commands" },
  { id: "limited", description: "Read-only turns; ask before each typed Bash command" },
  { id: "full-access", description: "Unrestricted Codex turns; no command approval prompts" },
];
const steps = ["Theme", "Approval mode", "Routing", "Review"];

export function StartupSetup({ config, width, height, hasRoutingKey, onSave, onFinish, onCancel }: {
  config: Config; width: number; height: number; hasRoutingKey: boolean;
  onSave: (config: Config) => Promise<void>; onFinish: () => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(config);
  const [step, setStep] = useState(0);
  const [index, setIndex] = useState(COLOR_SCHEMES.indexOf(config.colorScheme ?? "default"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const scheme = step === 0 ? COLOR_SCHEMES[index]! : draft.colorScheme;
  const theme = getTheme(undefined, scheme);
  const choices = step === 0 ? [...COLOR_SCHEMES] : step === 1 ? approvals.map(mode => mode.id)
    : step === 2 ? ["manual", "auto"] : ["Save and start Pace"];
  const selectedIndex = (stage: number, value: Config) => stage === 0 ? COLOR_SCHEMES.indexOf(value.colorScheme ?? "default")
    : stage === 1 ? approvals.findIndex(mode => mode.id === (value.approvalMode ?? "request-approval"))
    : stage === 2 ? (value.routingMode === "manual" ? 0 : 1) : 0;
  const { start, end } = menuWindow(choices.length, index, Math.max(1, Math.min(5, height - 7)));

  useInput((input, key) => {
    if (pending.current) return;
    if (key.escape || (key.ctrl && input === "c")) { onCancel(); return; }
    if (key.leftArrow && step > 0) {
      setStep(step - 1); setIndex(selectedIndex(step - 1, draft)); setError(undefined);
    } else if (key.upArrow || key.downArrow || key.tab) {
      const direction = key.upArrow || (key.tab && key.shift) ? -1 : 1;
      setIndex(value => (value + direction + choices.length) % choices.length);
    } else if (key.return) {
      if (step === 3) {
        pending.current = true; setSaving(true); setError(undefined);
        void onSave(draft).then(onFinish).catch(error => {
          setError(`Could not save setup: ${String(error)}`);
        }).finally(() => { pending.current = false; setSaving(false); });
      } else {
        const updated: Config = step === 0 ? { ...draft, colorScheme: COLOR_SCHEMES[index]! }
          : step === 1 ? { ...draft, approvalMode: approvals[index]!.id }
          : { ...draft, routingMode: index === 0 ? "manual" : "auto" };
        setDraft(updated); setStep(step + 1); setIndex(selectedIndex(step + 1, updated));
      }
    }
  });

  return <PanelFrame width={width} height={height}
    actions={<>
      {error ? <Text color={theme.error}>{error}</Text> : null}
      {saving ? <Text color={theme.warning}>Saving…</Text> : choices.slice(start, end).map((choice, offset) => (
        <Text key={choice} color={start + offset === index ? theme.primary : theme.muted} wrap="truncate-end">
          {start + offset === index ? "❯" : " "} {choice}
        </Text>
      ))}
    </>}
    footer="↑/↓/Tab select · Enter next · ← back · Esc cancel">
    <Text bold color={theme.primary}>Pace setup · {step + 1}/{steps.length} · {steps[step]}</Text>
    <Box flexDirection="column" marginTop={1}>
      {step === 0 ? <>
        <Text>Choose a color scheme. Changes are saved only at the end.</Text>
        <Text color={theme.secondary}>◆ Pace · <Text color={theme.accent}>Live theme preview</Text></Text>
      </> : step === 1 ? <Text>{approvals[index]!.description}</Text>
        : step === 2 ? <>
          <Text>{index === 0 ? "Use the default model directly, without Vex routing." : "Let Vex choose a model and reasoning effort for each turn."}</Text>
          <Text color={hasRoutingKey ? theme.muted : theme.warning}>{hasRoutingKey
            ? "A routing key is configured."
            : "Optional Vex routing needs a key; configure it with pace setup. Manual mode needs no routing key."}</Text>
        </> : <>
          <Text>Theme: {draft.colorScheme ?? "default"}</Text>
          <Text>Approval: {draft.approvalMode ?? "request-approval"}</Text>
          <Text>Routing: {draft.routingMode}</Text>
          <Text>Default model: {draft.defaultRoute.model ?? "Codex default"}{draft.defaultRoute.effort ? ` · ${draft.defaultRoute.effort}` : ""}</Text>
          <Text>Codex manages sign-in. If needed, exit and run codex login.</Text>
          <Text>Use /theme, /approval and /models to change preferences later.</Text>
        </>}
    </Box>
  </PanelFrame>;
}
