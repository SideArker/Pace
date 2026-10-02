import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import type { UserAnswers, UserQuestion } from "../integrations/codex-types.js";

export function QuestionPanel({ questions, onSubmit, isActive = true }: { questions: UserQuestion[]; onSubmit: (answers: UserAnswers) => void; isActive?: boolean }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<UserAnswers>({});
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(questions[0]?.options.length ? 0 : -1);
  const question = questions[index];
  const allowsText = !!question && (!question.options.length || question.isOther);
  const submit = () => {
    if (!question) return;
    const answer = selected >= 0 ? question.options[selected]?.label : draft.trim();
    if (!answer) return;
    const next = { ...answers, [question.id]: { answers: [answer] } };
    if (index + 1 === questions.length) onSubmit(next);
    else {
      setAnswers(next);
      setIndex(index + 1);
      setDraft("");
      setSelected(questions[index + 1]?.options.length ? 0 : -1);
    }
  };
  usePaste(text => {
    if (allowsText) { setDraft(value => value + text.replace(/\r\n?/g, "\n")); setSelected(-1); }
  }, { isActive });
  useInput((input, key) => {
    if (!question || key.escape || (key.ctrl && input === "c") || (key.shift && key.tab)) return;
    if (key.return) { submit(); return; }
    if (key.upArrow || key.downArrow || key.tab) {
      const count = question.options.length + (allowsText ? 1 : 0);
      if (count) {
        const at = selected < 0 ? count - 1 : selected;
        const next = (at + (key.upArrow ? -1 : 1) + count) % count;
        setSelected(next === question.options.length ? -1 : next);
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (allowsText) { setDraft(value => value.slice(0, -1)); setSelected(-1); }
      return;
    }
    if (!key.ctrl && !key.meta && input && allowsText) {
      setDraft(value => value + input);
      setSelected(-1);
    }
  }, { isActive });
  if (!question) return null;
  return <Box flexDirection="column" borderStyle="round" borderColor="#A5B4FC" paddingX={1}>
    <Text color="#A5B4FC" bold>Agent question {index + 1}/{questions.length} · {question.header}</Text>
    <Text wrap="wrap">{question.question}</Text>
    {question.options.map((option, at) => <Box key={at} flexDirection="column">
      <Text color={selected === at ? "#59E6A7" : undefined}>{selected === at ? "❯ " : "  "}{option.label}</Text>
      {option.description ? <Text dimColor>  {option.description}</Text> : null}
    </Box>)}
    {allowsText ? <Text color={selected === -1 ? "#59E6A7" : undefined}>
      {selected === -1 ? "❯ " : "  "}{question.options.length ? "Other: " : "Answer: "}{question.isSecret ? "•".repeat(draft.length) : draft}▌
    </Text> : null}
    <Text dimColor>↑/↓ or Tab select · type your answer · Enter send · Esc twice cancel · Shift+Tab conversations</Text>
  </Box>;
}
