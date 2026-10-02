import React from "react";
import { Box, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { BottomPanel } from "../src/components/BottomPanel.js";

describe("BottomPanel dynamic multi-column dock", () => {
  it("renders only Usage panel at full width when no other panels are active", () => {
    const output = renderToString(
      React.createElement(BottomPanel, {
        width: 80,
        height: 24,
        usageLimits: {
          primary: { usedPercent: 97, windowDurationMins: 300 },
          secondary: { usedPercent: 15, windowDurationMins: 10080 },
        },
      }),
      { columns: 80 },
    );

    expect(output).toContain("◈ Codex Usage");
    expect(output).toContain("3% left");
    expect(output).toContain("85% left");
    expect(output).not.toContain("Conversations");
    expect(output).not.toContain("Queued messages");
  });

  it("splits into 2 columns for Conversations and Usage", () => {
    const output = renderToString(
      React.createElement(BottomPanel, {
        width: 80,
        height: 24,
        conversations: {
          choices: [
            { id: "11111111-1111-1111-1111-111111111111", prompt: "First task", state: "ready" },
            { id: "22222222-2222-2222-2222-222222222222", prompt: "Second task", state: "running" },
          ],
          activeId: "11111111-1111-1111-111111111111",
          selectedIndex: 0,
          focused: false,
        },
        usageLimits: {
          primary: { usedPercent: 50, windowDurationMins: 300 },
        },
      }),
      { columns: 80 },
    );

    expect(output).toContain("Conversations");
    expect(output).toContain("11111111");
    expect(output).toContain("◈ Codex Usage");
    expect(output).toContain("50% left");
  });

  it("splits into 2 columns for Queued messages and Usage", () => {
    const output = renderToString(
      React.createElement(BottomPanel, {
        width: 80,
        height: 24,
        queuedPrompts: ["git status", "npm test"],
        usageLimits: {
          primary: { usedPercent: 40, windowDurationMins: 300 },
        },
      }),
      { columns: 80 },
    );

    expect(output).toContain("Queued messages (2)");
    expect(output).toContain("1. git status");
    expect(output).toContain("2. npm test");
    expect(output).toContain("◈ Codex Usage");
    expect(output).toContain("60% left");
  });

  it("splits into 3 columns in wide terminals when all panels are active", () => {
    const output = renderToString(
      React.createElement(BottomPanel, {
        width: 120,
        height: 24,
        conversations: {
          choices: [
            { id: "aaaa-1111", prompt: "Convo 1", state: "ready" },
            { id: "bbbb-2222", prompt: "Convo 2", state: "running" },
          ],
          selectedIndex: 0,
          focused: true,
        },
        queuedPrompts: ["Next turn"],
        usageLimits: {
          primary: { usedPercent: 90, windowDurationMins: 300 },
        },
      }),
      { columns: 120 },
    );

    expect(output).toContain("Conversations");
    expect(output).toContain("Queued messages (1)");
    expect(output).toContain("◈ Codex Usage");
  });

  it("renders clean Usage meters without embedded warning text and with perfect border alignment", () => {
    const output = renderToString(
      React.createElement(BottomPanel, {
        width: 80,
        height: 24,
        usageLimits: {
          primary: { usedPercent: 97, windowDurationMins: 300 },
          secondary: { usedPercent: 15, windowDurationMins: 10080 },
        },
      }),
      { columns: 80 },
    );

    expect(output).toContain("◈ Codex Usage");
    expect(output).toContain("3% left");
    expect(output).toContain("85% left");
    expect(output).not.toContain("warning");

    const lines = output.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const expectedWidth = lines[0]!.length;
    for (const line of lines) {
      expect(line.length).toBe(expectedWidth);
    }
  });

  it("adapts item limits when terminal height is constrained", () => {
    const prompts = Array.from({ length: 6 }, (_, i) => `Task ${i + 1}`);
    const output = renderToString(
      React.createElement(BottomPanel, {
        width: 80,
        height: 18,
        queuedPrompts: prompts,
      }),
      { columns: 80 },
    );

    expect(output).toContain("Task 1");
    expect(output).toContain("Task 2");
    expect(output).not.toContain("Task 4");
    expect(output).toContain("+4 more");
  });

  it("fits strictly within terminal columns when rendered inside a paddingX={1} container", () => {
    const terminalWidth = 100;
    const output = renderToString(
      React.createElement(
        Box,
        { flexDirection: "column", paddingX: 1 },
        React.createElement(BottomPanel, {
          width: terminalWidth - 2,
          height: 24,
          usageLimits: {
            primary: { usedPercent: 97, windowDurationMins: 300 },
            secondary: { usedPercent: 15, windowDurationMins: 10080 },
          },
        }),
      ),
      { columns: terminalWidth },
    );

    const lines = output.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(terminalWidth);
    }
  });

  it("stacks panels vertically when window width is constrained below TWO_COLUMN_MIN_WIDTH", () => {
    const output = renderToString(
      React.createElement(BottomPanel, {
        width: 65,
        height: 24,
        conversations: {
          choices: [
            { id: "08ce3944-1111", prompt: "New conversation", state: "done" },
            { id: "dfe73a14-2222", prompt: "Thinking About A Good Way To Handle This", state: "done" },
          ],
          selectedIndex: 0,
          focused: false,
        },
        usageLimits: {
          primary: { usedPercent: 0, windowDurationMins: 300 },
          secondary: { usedPercent: 15, windowDurationMins: 10080 },
        },
      }),
      { columns: 65 },
    );

    // Stacking vertically means Conversations appears above Codex Usage in separate full-width blocks
    const convoIndex = output.indexOf("Conversations");
    const usageIndex = output.indexOf("◈ Codex Usage");
    expect(convoIndex).toBeGreaterThan(-1);
    expect(usageIndex).toBeGreaterThan(-1);

    // Ensure conversation IDs are not split across lines
    expect(output).toContain("08ce3944");
    expect(output).toContain("dfe73a14");

    // Both panels are present and meters are intact
    expect(output).toContain("100% left");
    expect(output).toContain("85% left");
  });

  it("stacks all 3 panels vertically when width is below TWO_COLUMN_MIN_WIDTH", () => {
    const output = renderToString(
      React.createElement(BottomPanel, {
        width: 60,
        height: 24,
        showConversations: true,
        conversations: {
          choices: [
            { id: "aaaa-1111", prompt: "Convo 1", state: "ready" },
          ],
          selectedIndex: 0,
          focused: false,
        },
        queuedPrompts: ["npm run build"],
        usageLimits: {
          primary: { usedPercent: 50, windowDurationMins: 300 },
        },
      }),
      { columns: 60 },
    );

    const convoIndex = output.indexOf("Conversations");
    const queueIndex = output.indexOf("Queued messages");
    const usageIndex = output.indexOf("◈ Codex Usage");

    expect(convoIndex).toBeLessThan(queueIndex);
    expect(queueIndex).toBeLessThan(usageIndex);
  });

  it("uses 2-column top with full-width bottom for 3 panels when width is between 78 and 118", () => {
    const output = renderToString(
      React.createElement(BottomPanel, {
        width: 90,
        height: 24,
        showConversations: true,
        conversations: {
          choices: [
            { id: "aaaa-1111", prompt: "Convo 1", state: "ready" },
          ],
          selectedIndex: 0,
          focused: false,
        },
        queuedPrompts: ["npm run build"],
        usageLimits: {
          primary: { usedPercent: 50, windowDurationMins: 300 },
        },
      }),
      { columns: 90 },
    );

    expect(output).toContain("Conversations");
    expect(output).toContain("Queued messages");
    expect(output).toContain("◈ Codex Usage");
  });
});
