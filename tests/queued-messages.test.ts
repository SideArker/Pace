import React from "react";
import { renderToString } from "ink";
import { expect, it } from "vitest";
import { QueuedMessages } from "../src/components/QueuedMessages.js";
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
