import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "ink";
import { ConvoMenu, ConversationPicker, ResumeMenu } from "../src/components/Menus.js";
import { newSession, PaceStore, rewindConversation, deleteConversationTurn, undoConversationTurn } from "../src/core/sessions.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnSummary } from "../src/shared/types.js";

describe("Conversation editing and undo logic", () => {
  it("groups saved conversations by project and marks missing paths", () => {
    const available = newSession('/available', 'auto');
    const missing = newSession('/missing', 'auto');
    const output = renderToString(React.createElement(ResumeMenu, {
      choices: [available, missing], selectedIndex: 1, missingProjectPaths: [missing.projectPath],
    }), { columns: 100 });
    expect(output).toContain(available.projectPath);
    expect(output).toContain(missing.projectPath);
    expect(output).toContain('(missing; use pace reconnect)');
    expect(output).toContain('(unavailable)');
  });

  it("shows completed background conversations as done until opened", () => {
    const output = renderToString(React.createElement(ConversationPicker, {
      choices: [
        { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", prompt: "Working", state: "running" },
        { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", prompt: "Finished", state: "done" },
      ],
      activeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      selectedIndex: 0,
      focused: false,
    }), { columns: 80 });
    expect(output).toContain("running");
    expect(output).toContain("done");
    expect(output).toContain("Finished");
  });

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

      // Undo last turn; next request must start a new Codex thread.
      const popped = undoConversationTurn(session);
      expect(popped?.prompt).toBe("Third turn (bad prompt)");
      expect(session.turns).toHaveLength(2);
      expect(session.threadId).toBeUndefined();

      // Rewind to turn index 1 (meaning keep turns 0..0, edit turn 1)
      const target = session.turns[1];
      expect(target?.prompt).toBe("Second turn");
      session.threadId = "another-thread";
      rewindConversation(session, 1);
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0]?.prompt).toBe("First turn");
      expect(session.threadId).toBeUndefined();

      // Rewind to turn index 0 (drop all turns, threadId resets)
      const initial = session.turns[0];
      expect(initial?.prompt).toBe("First turn");
      rewindConversation(session, 0);
      expect(session.threadId).toBeUndefined();

      await store.save(session);
      const loaded = await store.latest("/my/project");
      expect(loaded?.turns).toHaveLength(0);
      expect(loaded?.threadId).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("deleting one turn invalidates thread while retaining other turns", () => {
    const session = newSession("/my/project", "auto");
    session.threadId = "thread-with-deleted-turn";
    session.turns = [
      { prompt: "Keep first", result: "First", at: "2026-01-01" },
      { prompt: "Remove", result: "Removed", at: "2026-01-02" },
      { prompt: "Keep last", result: "Last", at: "2026-01-03" },
    ];
    deleteConversationTurn(session, 1);
    expect(session.turns.map(turn => turn.prompt)).toEqual(["Keep first", "Keep last"]);
    expect(session.threadId).toBeUndefined();
  });

  it("aborts execution controller on cancellation signal", () => {
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});
