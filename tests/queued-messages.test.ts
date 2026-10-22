import React from "react";
import { renderToString } from "ink";
import { expect, it } from "vitest";
import { QueuedMessages } from "../src/components/QueuedMessages.js";
import { QueueMenu } from "../src/components/ConversationMenus.js";
import { isSecondEscape } from "../src/components/useAppInput.js";

it("requires two Esc presses for the same conversation within 750 ms", () => {
  const first = { sessionId: "conversation-a", at: 1000 };
  expect(isSecondEscape(first, "conversation-a", 1500)).toBe(true);
  expect(isSecondEscape(first, "conversation-a", 1751)).toBe(false);
  expect(isSecondEscape(first, "conversation-b", 1500)).toBe(false);
  expect(isSecondEscape(undefined, "conversation-a", 1500)).toBe(false);
});

it("shows queued messages in a bounded conversation-style box", () => {
  const prompts = Array.from({ length: 7 }, (_, index) => `Message ${index + 1}\ncontinued`);
  const output = renderToString(React.createElement(QueuedMessages, { prompts }), { columns: 80 });
  expect(output).toContain("Queued messages (7)");
  expect(output).toContain("1. Message 1 continued");
  expect(output).toContain("5. Message 5 continued");
  expect(output).not.toContain("Message 6 continued");
  expect(output).toContain("+2 more queued");
});

it("renders QueueMenu with selected item and navigation hint", () => {
  const prompts = ["Prompt 1", "Prompt 2", "Prompt 3"];
  const output = renderToString(React.createElement(QueueMenu, { prompts, selectedIndex: 1 }));
  expect(output).toContain("Queued messages (3)");
  expect(output).toContain("▶");
  expect(output).toContain("#2");
  expect(output).toContain("Prompt 2");
  expect(output).toContain("→ edit in composer");
  expect(output).toContain("S steer now");
  expect(output).toContain("Alt+Del/Backspace/d delete");
});

it("shows editing hints in wide QueuedMessages view", () => {
  const output = renderToString(React.createElement(QueuedMessages, { prompts: ["Task to run"], width: 80 }));
  expect(output).toContain("↓ select · → edit");
  expect(output).toContain("Alt+Del remove");
  expect(output).toContain("S steer");
});
