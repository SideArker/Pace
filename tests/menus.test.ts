import React from "react";
import { renderToString } from "ink";
import { expect, it } from "vitest";
import { ApprovalModeMenu, CommandMenu, ConvoMenu, menuWindow, truncateWithEllipsis } from "../src/components/ConversationMenus.js";
import { ResumeMenu } from "../src/components/ResumeMenu.js";
import { ModelMenu } from "../src/components/ModelMenu.js";
import { newSession } from "../src/core/sessions.js";

it("truncates text with ellipsis only when exceeding maxLength", () => {
  expect(truncateWithEllipsis("short", 10)).toBe("short");
  expect(truncateWithEllipsis("exact len", 9)).toBe("exact len");
  expect(truncateWithEllipsis("longer than limit", 10)).toBe("longer...");
});

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

it("renders command arguments, truncates descriptions with ellipsis, and shows selected detail preview", () => {
  const matches = ["/plan", "/models", "/exit", "/@caveman"];
  const args = { "/plan": "<prompt>", "/@caveman": "[mode]" };
  const descriptions = {
    "/plan": "Start or toggle planning mode",
    "/models": "Choose model and reasoning effort",
    "/exit": "Quit Pace",
    "/@caveman": "Ultra-compressed communication mode that cuts output tokens.\nSecond line explanation of caveman mode.",
  };
  const rendered = renderToString(React.createElement(CommandMenu, {
    matches,
    descriptions,
    args,
    selectedIndex: 3,
    width: 60,
  }));
  expect(rendered).toContain("/plan");
  expect(rendered).toContain("<prompt>");
  expect(rendered).toContain("/@caveman");
  expect(rendered).toContain("[mode]");
  expect(rendered).toContain("...");
  expect(rendered).toContain("Second line explanation of caveman mode.");
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

it("shows discovered model status and its supported reasoning choices", () => {
  const models = renderToString(React.createElement(ModelMenu, {
    mode: "models", models: ["gpt-5.6-sol"], selectedModel: "gpt-5.6-sol", selectedIndex: 0, catalogStatus: "ready",
  }));
  expect(models).toContain("gpt-5.6-sol");
  const efforts = renderToString(React.createElement(ModelMenu, {
    mode: "efforts", models: ["gpt-5.6-sol"], efforts: ["medium", "ultra"], selectedModel: "gpt-5.6-sol", selectedIndex: 0,
  }));
  expect(efforts).toContain("medium");
  expect(efforts).toContain("ultra");
  expect(efforts).not.toContain("xhigh");
  expect(efforts).toContain("M use manually");
});

it("shows separate categories for commands and skills in CommandMenu", () => {
  const matches = ["/help", "/plan", "/caveman", "/stats"];
  const skillNames = new Set(["caveman", "stats"]);

  // Scrolled at top: commands first, transition into skills
  const rendered = renderToString(React.createElement(CommandMenu, {
    matches,
    skillNames,
    selectedIndex: 0,
    width: 60,
  }));
  expect(rendered).toContain("◈ Commands");
  expect(rendered).toContain("◈ Skills");
  expect(rendered.indexOf("◈ Commands")).toBeLessThan(rendered.indexOf("◈ Skills"));
  expect(rendered.indexOf("◈ Skills")).toBeLessThan(rendered.indexOf("/caveman"));

  // Scrolled so only skills are in the visible slice
  const onlySkills = renderToString(React.createElement(CommandMenu, {
    matches: ["/caveman", "/stats"],
    skillNames,
    selectedIndex: 0,
    width: 60,
  }));
  expect(onlySkills).toContain("◈ Skills");
  expect(onlySkills).not.toContain("◈ Commands");
});

it("clamps column widths safely without overflowing narrow terminals", () => {
  const matches = ["/a-very-long-command-name-with-arguments"];
  const args = { "/a-very-long-command-name-with-arguments": "<huge-parameter-list-that-should-not-wrap>" };
  const descriptions = { "/a-very-long-command-name-with-arguments": "Description here" };

  const narrow = renderToString(React.createElement(CommandMenu, {
    matches,
    args,
    descriptions,
    selectedIndex: 0,
    width: 40,
  }));
  expect(narrow).toContain("/a-very-long-co");
  expect(narrow).toContain("Description here");
});
