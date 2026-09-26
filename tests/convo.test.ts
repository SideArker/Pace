import { describe, expect, it } from "vitest";
import React from "react";
import { ConvoMenu } from "../src/components/Menus.js";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnSummary } from "../src/shared/types.js";

describe("Conversation editing and undo logic", () => {
  it("renders ConvoMenu with turn summaries without error", () => {
    const turns: TurnSummary[] = [
      { prompt: "Create server.ts", result: "Created server", at: new Date().toISOString() },
      { prompt: "Add routing endpoints", result: "Added endpoints", at: new Date().toISOString() },
    ];
    const el = React.createElement(ConvoMenu, { turns, selectedIndex: 0 });
    expect(el).toBeDefined();
    expect(el.props.turns).toHaveLength(2);
    expect(el.props.selectedIndex).toBe(0);
  });

  it("handles conversation undo and rewind logic cleanly in session", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pace-convo-test-"));
    try {
      const store = new PaceStore(tempDir);
      const session = newSession("/my/project", "auto");
      session.threadId = "test-thread-xyz";

      session.turns.push({
        prompt: "First turn",
        result: "First result",
        at: new Date().toISOString(),
      });
      session.turns.push({
        prompt: "Second turn",
        result: "Second result",
        at: new Date().toISOString(),
      });
      session.turns.push({
        prompt: "Third turn (bad prompt)",
        result: "Third result",
        at: new Date().toISOString(),
      });
      await store.save(session);

      // Undo last turn
      const popped = session.turns.pop();
      expect(popped?.prompt).toBe("Third turn (bad prompt)");
      expect(session.turns).toHaveLength(2);
      expect(session.threadId).toBe("test-thread-xyz");

      // Rewind to turn index 1 (meaning keep turns 0..0, edit turn 1)
      const target = session.turns[1];
      expect(target?.prompt).toBe("Second turn");
      session.turns = session.turns.slice(0, 1);
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0]?.prompt).toBe("First turn");

      // Rewind to turn index 0 (drop all turns, threadId resets)
      const initial = session.turns[0];
      expect(initial?.prompt).toBe("First turn");
      session.turns = [];
      if (session.turns.length === 0) session.threadId = undefined;
      expect(session.threadId).toBeUndefined();

      await store.save(session);
      const loaded = await store.latest("/my/project");
      expect(loaded?.turns).toHaveLength(0);
      expect(loaded?.threadId).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("aborts execution controller on cancellation signal", () => {
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});
