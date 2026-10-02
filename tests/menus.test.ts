import React from "react";
import { renderToString } from "ink";
import { expect, it } from "vitest";
import { ApprovalModeMenu, CommandMenu, ConvoMenu, menuWindow } from "../src/components/ConversationMenus.js";
import { ResumeMenu } from "../src/components/ResumeMenu.js";
import { ModelMenu } from "../src/components/ModelMenu.js";
import { newSession } from "../src/core/sessions.js";

it("keeps selected entry inside a five-row window", () => {
  expect(menuWindow(12, 0)).toEqual({ start: 0, end: 5 });
  expect(menuWindow(12, 6)).toEqual({ start: 4, end: 9 });
  expect(menuWindow(12, 11)).toEqual({ start: 7, end: 12 });
});

it("shows current approval mode and keyboard choices", () => {
  const output = renderToString(React.createElement(ApprovalModeMenu, { selectedIndex: 1, currentMode: "request-approval" }));
  expect(output).toContain("request-approval (current)");
  expect(output).toContain("▶ limited");
  expect(output).toContain("Enter save");
});

it("scrolls command matches and conversation turns with selection", () => {
  const matches = Array.from({ length: 12 }, (_, index) => `/command${index}`);
  const commands = renderToString(React.createElement(CommandMenu, { matches, selectedIndex: 8 }));
  expect(commands).toContain("/command8");
  expect(commands).toContain("7–11 of 12");
  expect(commands).not.toContain("/command0");
  expect(commands).not.toContain("/command11");

  const turns = matches.map(prompt => ({ prompt, result: "", at: "2026-09-29T12:00:00Z" }));
  const conversation = renderToString(React.createElement(ConvoMenu, { turns, selectedIndex: 8 }));
  expect(conversation).toContain("/command8");
  expect(conversation).not.toContain("/command0");
  expect(conversation).not.toContain("/command11");
});

it("limits resume and model menus while retaining selected entry", () => {
  const choices = Array.from({ length: 12 }, (_, index) => {
    const session = newSession("/project", "auto");
    session.turns.push({ prompt: `prompt${index}`, result: "", at: "2026-09-29T12:00:00Z" });
    return session;
  });
  const resume = renderToString(React.createElement(ResumeMenu, { choices, selectedIndex: 8 }));
  expect(resume).toContain("prompt8");
  expect(resume).not.toContain("prompt0");
  expect(resume).not.toContain("prompt11");

  const models = Array.from({ length: 12 }, (_, index) => `model${index}`);
  const model = renderToString(React.createElement(ModelMenu, { mode: "models", models, selectedModel: "model8", selectedIndex: 8 }));
  expect(model).toContain("model8");
  expect(model).not.toContain("model0");
  expect(model).not.toContain("model11");
});
