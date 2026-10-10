import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "ink";
import { ConvoMenu, ConversationPicker, ResumeMenu, sortConversations, sectionConversations, resolveRepoTitle } from "../src/components/Menus.js";
import { newSession, PaceStore, rewindConversation, deleteConversationTurn, undoConversationTurn } from "../src/core/sessions.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnSummary } from "../src/shared/types.js";
import { conversationState } from "../src/components/approval-state.js";
import { loadResumeChoices } from "../src/components/resume-choices.js";

describe("Conversation editing and undo logic", () => {
  it("shows approval before running for a background turn", () => {
    expect(conversationState(true, true)).toBe("approval");
    expect(conversationState(true, false)).toBe("running");
    const output = renderToString(React.createElement(ConversationPicker, {
      choices: [
        { id: "active", prompt: "Active conversation", state: "running" },
        { id: "waiting", prompt: "Waiting conversation", state: conversationState(true, true) },
      ], activeId: "active", selectedIndex: 0, focused: false,
    }), { columns: 80 });
    expect(output).toContain("approve");
    expect(output).toContain("Waiting conversation");
  });
  it("marks a background question as waiting for an answer", () => {
    expect(conversationState(true, false, true)).toBe("question");
    const output = renderToString(React.createElement(ConversationPicker, {
      choices: [
        { id: "active", prompt: "Active conversation", state: "running" },
        { id: "waiting", prompt: "Waiting conversation", state: conversationState(true, false, true) },
      ], activeId: "active", selectedIndex: 0, focused: false,
    }), { columns: 80 });
    expect(output).toContain("answer");
    expect(output).toContain("Waiting conversation");
  });
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

  it("labels saved conversations with their directories in the active picker", () => {
    const output = renderToString(React.createElement(ConversationPicker, {
      choices: [
        { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", projectPath: "/workspace/alpha", prompt: "Alpha task", state: "done", section: "saved" },
        { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", projectPath: "/workspace/beta", prompt: "Beta task", state: "done", section: "saved" },
      ], selectedIndex: 1, focused: true, maxItems: 4, width: 100,
    }), { columns: 100 });
    expect(output).toContain("/workspace/alpha");
    expect(output).toContain("/workspace/beta");
    expect(output.indexOf("/workspace/alpha")).toBeLessThan(output.indexOf("Alpha task"));
    expect(output.indexOf("/workspace/beta")).toBeLessThan(output.indexOf("Beta task"));
  });

  it("loads resume choices from every saved project and tracks missing directories", async () => {
    const local = newSession("/workspace/local", "auto");
    const other = newSession("/workspace/other", "auto");
    const missing = newSession("/workspace/gone", "auto");
    const store = { listProjects: async () => [
      { projectPath: local.projectPath, exists: true, sessions: [local] },
      { projectPath: other.projectPath, exists: true, sessions: [other] },
      { projectPath: missing.projectPath, exists: false, sessions: [missing] },
    ] };
    const result = await loadResumeChoices(store, [local], []);
    expect(result.sessions.map(session => session.id)).toEqual([local.id, other.id, missing.id]);
    expect(result.missingProjectPaths).toEqual([missing.projectPath]);
  });

  it("keeps saved conversations from the same directory together", () => {
    const choices = sectionConversations([
      { id: "alpha-new", projectPath: "/workspace/alpha", state: "done" as const, updatedAt: "2026-10-10T12:00:00Z" },
      { id: "beta", projectPath: "/workspace/beta", state: "done" as const, updatedAt: "2026-10-10T11:00:00Z" },
      { id: "alpha-old", projectPath: "/workspace/alpha", state: "done" as const, updatedAt: "2026-10-10T10:00:00Z" },
    ], new Set());
    expect(choices.map(choice => choice.id)).toEqual(["alpha-new", "alpha-old", "beta"]);
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

  it("sorts conversations by 1. Running, 2. Approve, 3. done (by last active time)", () => {
    const sorted = sortConversations([
      { id: "1", prompt: "Done older", state: "done", updatedAt: "2026-09-30T10:00:00Z" },
      { id: "2", prompt: "Running now", state: "running", updatedAt: "2026-09-30T09:00:00Z" },
      { id: "3", prompt: "Waiting approval", state: "approval", updatedAt: "2026-09-30T08:00:00Z" },
      { id: "4", prompt: "Done newer", state: "done", updatedAt: "2026-09-30T12:00:00Z" },
    ]);

    expect(sorted.map(s => s.id)).toEqual(["2", "3", "4", "1"]);
    expect(sorted[0]!.state).toBe("running");
    expect(sorted[1]!.state).toBe("approval");
    expect(sorted[2]!.id).toBe("4"); // Done newer (12:00) before Done older (10:00)
    expect(sorted[3]!.id).toBe("1");
  });

  it("keeps this Pace's state order and saved conversations in time order", () => {
    const choices = sectionConversations([
      { id: "saved-old", prompt: "Older saved", state: "running", updatedAt: "2026-09-30T10:00:00Z" },
      { id: "local-done", prompt: "Done here", state: "done", updatedAt: "2026-09-30T12:00:00Z" },
      { id: "saved-new", prompt: "Newer saved", state: "done", updatedAt: "2026-09-30T13:00:00Z" },
      { id: "local-running", prompt: "Running here", state: "running", updatedAt: "2026-09-30T09:00:00Z" },
    ], new Set(["local-done", "local-running"]));
    expect(choices.map(choice => choice.id)).toEqual(["local-running", "local-done", "saved-new", "saved-old"]);
    const output = renderToString(React.createElement(ConversationPicker, {
      choices, activeId: "local-running", selectedIndex: 2, focused: true, maxItems: 4,
    }), { columns: 100 });
    expect(output.indexOf("This pace")).toBeLessThan(output.indexOf("Saved conversations"));
    expect(output.indexOf("Newer saved")).toBeLessThan(output.indexOf("Older saved"));
    expect(output).toContain("▶ saved-ne");
    const compact = renderToString(React.createElement(ConversationPicker, {
      choices, activeId: "local-running", selectedIndex: 2, focused: true, maxItems: 2,
    }), { columns: 80 });
    expect(compact).toContain("Running here");
    expect(compact).toContain("Newer saved");
  });

  it("moves a resumed conversation to This pace after a new message", () => {
    const ids = new Set(["new-here"]);
    const sessions = [
      { id: "new-here", state: "done" as const, updatedAt: "2026-09-30T11:00:00Z" },
      { id: "resumed", state: "done" as const, updatedAt: "2026-09-30T10:00:00Z" },
    ];
    expect(sectionConversations(sessions, ids).map(item => [item.id, item.section])).toEqual([
      ["new-here", "pace"], ["resumed", "saved"],
    ]);
    ids.add("resumed"); // The new message starts a turn in the resumed conversation.
    const choices = sectionConversations(sessions, ids);
    expect(choices.map(item => [item.id, item.section])).toEqual([
      ["new-here", "pace"], ["resumed", "pace"],
    ]);
    expect(choices.filter(item => item.id === "resumed")).toHaveLength(1);
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

  it("restores saved action records", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pace-actions-test-"));
    try {
      const store = new PaceStore(tempDir);
      const session = newSession("/my/project", "auto");
      session.turns.push({ prompt: "Edit file", result: "Done", at: new Date().toISOString(), activities: [
        { category: "thinking", text: "Thinking", durationMs: 1800, tokens: 32 },
        { category: "files", text: "Edited src/file.ts", outcome: "success" },
      ] });
      await store.save(session);
      expect((await store.latest("/my/project"))?.turns[0]?.activities).toEqual(session.turns[0]?.activities);
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

  it("disambiguates duplicate repo basenames and displays full path for non-git dirs", () => {
    // Current working directory is a git repo
    const currentRepo = process.cwd();
    expect(resolveRepoTitle(currentRepo, [currentRepo]).isRepo).toBe(true);

    // Duplicate basename
    const allPaths = ["/work/my-app", "/personal/my-app"];
    const resolvedWork = resolveRepoTitle("/work/my-app", allPaths);
    expect(resolvedWork.title).toBe("/work/my-app");

    // Non-git folder
    const nonGit = resolveRepoTitle("/tmp/scratch", ["/tmp/scratch"]);
    expect(nonGit.title).toBe("/tmp/scratch");
    expect(nonGit.isRepo).toBe(false);
  });

  it("prioritizes current repository in saved sections", () => {
    const choices = sectionConversations([
      { id: "other", projectPath: "/repo/other", state: "done" as const, updatedAt: "2026-10-10T12:00:00Z" },
      { id: "current", projectPath: "/repo/current", state: "done" as const, updatedAt: "2026-10-10T10:00:00Z" },
      { id: "pace-active", projectPath: "/repo/current", state: "running" as const, updatedAt: "2026-10-10T09:00:00Z" },
    ], new Set(["pace-active"]), "/repo/current");

    expect(choices[0]!.id).toBe("pace-active");
    expect(choices[0]!.sectionTitle).toBe("This pace");
    expect(choices[1]!.id).toBe("current");
    expect(choices[2]!.id).toBe("other");
  });

  it("filters choices by search query and displays search bar when focused", () => {
    const choices = [
      { id: "alpha-id", sectionTitle: "AlphaRepo", prompt: "Build new frontend", state: "done" as const, section: "saved" as const },
      { id: "beta-id", sectionTitle: "BetaRepo", prompt: "Fix database query", state: "done" as const, section: "saved" as const },
    ];

    // Focused search bar
    const focusedOutput = renderToString(React.createElement(ConversationPicker, {
      choices,
      selectedIndex: 0,
      focused: true,
      searchQuery: "BetaRepo",
    }));
    expect(focusedOutput).toContain("Search repo/convo:");
    expect(focusedOutput).toContain("BetaRepo");
    expect(focusedOutput).toContain("Fix database query");
    expect(focusedOutput).not.toContain("Build new frontend");

    // Search by prompt
    const promptSearch = renderToString(React.createElement(ConversationPicker, {
      choices,
      selectedIndex: 0,
      focused: true,
      searchQuery: "database",
    }));
    expect(promptSearch).toContain("Fix database query");
    expect(promptSearch).not.toContain("Build new frontend");
  });
});
