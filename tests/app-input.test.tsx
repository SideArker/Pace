import React from "react";
import { PassThrough, Writable } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { render, Text } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppInput } from "../src/components/useAppInput.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import { newSession } from "../src/core/sessions.js";

type Input = (value: string, key: Partial<Record<string, boolean>>) => void;
let inputHandler: Input | undefined;
vi.mock("ink", async importOriginal => {
  const ink = await importOriginal<typeof import("ink")>();
  return { ...ink, useInput: (handler: Input) => { inputHandler = handler; } };
});

class Output extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { done(); }
}

type Options = Parameters<typeof useAppInput>[0];
function fixture(overrides: Partial<Options> = {}) {
  const session = newSession(process.cwd(), "manual");
  const second = newSession(process.cwd(), "manual");
  const queue = new PromptQueue();
  const events = {
    interrupt: vi.fn(), activateSession: vi.fn(async () => {}), focusPicker: vi.fn(() => true),
    redrawTranscript: vi.fn(), toggleModel: vi.fn(), toggleEffort: vi.fn(),
    selectApprovalMode: vi.fn(async () => {}), add: vi.fn(), renderSessionTurns: vi.fn(),
    setPickerFocused: vi.fn(), setPickerIndex: vi.fn(), setOutputsExpanded: vi.fn(),
    setApprovalMenu: vi.fn(), setModelMenu: vi.fn(), setMenuIndex: vi.fn(),
    setMenuModel: vi.fn(), setResumeMenu: vi.fn(), setConvoMenu: vi.fn(),
    setSession: vi.fn(), setDraft: vi.fn(), setHistory: vi.fn(),
    setQueueMenu: vi.fn(), setQueueVersion: vi.fn(),
  };
  const options = {
    ...events, pickerFocused: false, pickerIndex: 0, openSessions: [session, second],
    approval: undefined, question: undefined,
    pendingApprovals: { current: new Map() }, activeSessionId: { current: session.id },
    jobs: { current: new Map() }, sideAbort: { current: undefined },
    outputsExpanded: false, modelMenu: undefined, approvalMenu: false,
    menuModels: ["first", "second", "third"], menuIndex: 0,
    resumeMenu: false, resumeChoices: [session, second], missingProjectPaths: [],
    convoMenu: false, session, store: { save: vi.fn(async () => {}) },
    queueMenu: false, promptQueue: { current: queue },
    ...overrides,
  } as unknown as Options;
  return { options, events, session, second, queue };
}

const instances: Array<ReturnType<typeof render>> = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.unmount();
  inputHandler = undefined;
  vi.useRealTimers();
});

async function mount(options: Options) {
  function Hook() { return <Text>{useAppInput(options) ? "Cancel armed" : "Ready"}</Text>; }
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (value: boolean) => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const instance = render(<Hook />, {
    stdin: stdin as unknown as ReadStream,
    stdout: new Output() as unknown as WriteStream,
    stderr: new PassThrough() as unknown as WriteStream,
    patchConsole: false, alternateScreen: false,
  });
  instances.push(instance);
  await instance.waitUntilRenderFlush();
  return {
    instance,
    async key(value = "", flags: Partial<Record<string, boolean>> = {}) {
      expect(inputHandler).toBeTypeOf("function");
      inputHandler!(value, flags);
      await instance.waitUntilRenderFlush();
    },
  };
}

describe("application keyboard input", () => {
  it("closes the conversation picker with Escape, Tab, or Up at its first row", async () => {
    for (const key of [{ escape: true }, { tab: true }, { upArrow: true }]) {
      const { options, events } = fixture({ pickerFocused: true });
      const ui = await mount(options);
      await ui.key("", key);
      expect(events.setPickerFocused).toHaveBeenCalledWith(false);
      ui.instance.unmount();
    }
  });

  it("moves through the picker and wraps at the last conversation", async () => {
    const { options, events } = fixture({ pickerFocused: true, pickerIndex: 1 });
    const ui = await mount(options);
    await ui.key("", { downArrow: true });
    expect(events.setPickerIndex.mock.calls[0]![0](1)).toBe(0);
    await ui.key("", { upArrow: true });
    expect(events.setPickerIndex.mock.calls[1]![0](1)).toBe(0);
  });

  it("activates another picked conversation and ignores the current one", async () => {
    const { options, events, second } = fixture({ pickerFocused: true, pickerIndex: 1 });
    const ui = await mount(options);
    await ui.key("", { return: true });
    expect(events.activateSession).toHaveBeenCalledWith(second);
    expect(events.setPickerFocused).toHaveBeenCalledWith(false);
    const current = fixture({ pickerFocused: true });
    const currentUi = await mount(current.options);
    await currentUi.key("", { return: true });
    expect(current.events.activateSession).not.toHaveBeenCalled();
  });

  it("sends approval keys to the pending request for the active conversation", async () => {
    const { options, session } = fixture();
    const respond = vi.fn();
    options.approval = { kind: "approval" } as Options["approval"];
    options.pendingApprovals.current.set(session.id, { respond } as never);
    const ui = await mount(options);
    await ui.key("Y");
    await ui.key("n");
    expect(respond.mock.calls.map(call => call[0])).toEqual(["accept", "decline"]);
  });

  it("never answers a background conversation's approval", async () => {
    const { options, second } = fixture();
    const respond = vi.fn();
    options.approval = { kind: "approval" } as Options["approval"];
    options.pendingApprovals.current.set(second.id, { respond } as never);
    const ui = await mount(options);
    await ui.key("y");
    expect(respond).not.toHaveBeenCalled();
  });

  it("focuses conversations from an approval with Down and from a question with Shift+Tab", async () => {
    const approval = fixture({ approval: { kind: "approval" } as Options["approval"] });
    const first = await mount(approval.options);
    await first.key("", { downArrow: true });
    expect(approval.events.focusPicker).toHaveBeenCalledOnce();
    const question = fixture({ question: { kind: "question" } as Options["question"] });
    const second = await mount(question.options);
    await second.key("", { shift: true, tab: true });
    expect(question.events.focusPicker).toHaveBeenCalledOnce();
  });

  it("requires two Escape presses to interrupt an active turn", async () => {
    const { options, events, session } = fixture();
    options.jobs.current.set(session.id, {} as never);
    const ui = await mount(options);
    await ui.key("", { escape: true });
    expect(events.interrupt).not.toHaveBeenCalled();
    await ui.key("", { escape: true });
    expect(events.interrupt).toHaveBeenCalledOnce();
  });

  it("does not interrupt when no turn, approval, or question is active", async () => {
    const { options, events } = fixture();
    const ui = await mount(options);
    await ui.key("", { escape: true });
    await ui.key("", { escape: true });
    expect(events.interrupt).not.toHaveBeenCalled();
  });

  it("Ctrl+C interrupts immediately, including while a menu is open", async () => {
    const { options, events } = fixture({ modelMenu: "models" });
    const ui = await mount(options);
    await ui.key("c", { ctrl: true });
    expect(events.interrupt).toHaveBeenCalledOnce();
    expect(events.setModelMenu).not.toHaveBeenCalled();
  });

  it("Ctrl+O redraws and toggles output details", async () => {
    const { options, events } = fixture();
    const ui = await mount(options);
    await ui.key("o", { ctrl: true });
    expect(events.redrawTranscript).toHaveBeenCalledOnce();
    expect(events.setOutputsExpanded.mock.calls[0]![0](false)).toBe(true);
    expect(events.setOutputsExpanded.mock.calls[0]![0](true)).toBe(false);
  });

  it("model menu wraps navigation, selects a model, and enters effort selection", async () => {
    const { options, events } = fixture({ modelMenu: "models" });
    const ui = await mount(options);
    await ui.key("", { upArrow: true });
    expect(events.setMenuIndex.mock.calls[0]![0](0)).toBe(2);
    await ui.key("", { return: true });
    expect(events.setMenuModel).toHaveBeenCalledWith("first");
    expect(events.setModelMenu).toHaveBeenCalledWith("efforts");
    expect(events.setMenuIndex).toHaveBeenCalledWith(0);
  });

  it("model menu toggles a model with Space and backs out with Escape", async () => {
    const { options, events } = fixture({ modelMenu: "models", menuIndex: 1 });
    const ui = await mount(options);
    await ui.key(" ");
    expect(events.toggleModel).toHaveBeenCalledWith("second");
    await ui.key("", { escape: true });
    expect(events.setModelMenu).toHaveBeenCalledWith(undefined);
  });

  it("effort menu toggles on Enter and Escape returns to models", async () => {
    const { options, events } = fixture({ modelMenu: "efforts", menuIndex: 0 });
    const ui = await mount(options);
    await ui.key("", { return: true });
    expect(events.toggleEffort).toHaveBeenCalledOnce();
    await ui.key("", { escape: true });
    expect(events.setModelMenu).toHaveBeenCalledWith("models");
  });

  it("approval mode menu wraps and confirms the selected mode", async () => {
    const { options, events } = fixture({ approvalMenu: true, menuIndex: 2 });
    const ui = await mount(options);
    await ui.key("", { tab: true });
    expect(events.setMenuIndex.mock.calls[0]![0](2)).toBe(0);
    await ui.key("", { return: true });
    expect(events.selectApprovalMode).toHaveBeenCalledWith("full-access");
  });

  it("resume menu reports a missing project instead of activating it", async () => {
    const { options, events, second } = fixture({ resumeMenu: true, menuIndex: 1 });
    options.missingProjectPaths = [second.projectPath];
    const ui = await mount(options);
    await ui.key("", { return: true });
    expect(events.activateSession).not.toHaveBeenCalled();
    expect(events.add).toHaveBeenCalledWith("error", expect.stringContaining("Project folder is missing"));
  });

  it("resume menu activates an available selected conversation", async () => {
    const { options, events, second } = fixture({ resumeMenu: true, menuIndex: 1 });
    const ui = await mount(options);
    await ui.key("", { return: true });
    expect(events.activateSession).toHaveBeenCalledWith(second);
  });

  it("queue menu edits only the active conversation's selected prompt", async () => {
    const { options, events, queue, session, second } = fixture({ queueMenu: true, menuIndex: 1 });
    queue.add(session.id, "first"); queue.add(session.id, "edit me"); queue.add(second.id, "keep me");
    const ui = await mount(options);
    await ui.key("", { rightArrow: true });
    expect(queue.list(session.id)).toEqual(["first"]);
    expect(queue.list(second.id)).toEqual(["keep me"]);
    expect(events.setDraft).toHaveBeenCalledWith("edit me");
    expect(events.setQueueMenu).toHaveBeenCalledWith(false);
  });

  it("queue menu deletes a prompt and clamps selection to the remaining row", async () => {
    const { options, events, queue, session } = fixture({ queueMenu: true, menuIndex: 1 });
    queue.add(session.id, "first"); queue.add(session.id, "last");
    const ui = await mount(options);
    await ui.key("d");
    expect(queue.list(session.id)).toEqual(["first"]);
    expect(events.setMenuIndex).toHaveBeenCalledWith(0);
    expect(events.setDraft).not.toHaveBeenCalled();
  });

  it("queue menu closes when its last prompt is deleted", async () => {
    const { options, events, queue, session } = fixture({ queueMenu: true });
    queue.add(session.id, "last");
    const ui = await mount(options);
    await ui.key("", { backspace: true });
    expect(queue.list(session.id)).toEqual([]);
    expect(events.setQueueMenu).toHaveBeenCalledWith(false);
  });

  it("queue menu Escape preserves pending prompts", async () => {
    const { options, events, queue, session } = fixture({ queueMenu: true });
    queue.add(session.id, "keep");
    const ui = await mount(options);
    await ui.key("", { escape: true });
    expect(queue.list(session.id)).toEqual(["keep"]);
    expect(events.setQueueMenu).toHaveBeenCalledWith(false);
  });

  it("Ctrl+Z restores the latest completed prompt to the composer", async () => {
    const { options, events, session } = fixture();
    session.turns.push({ prompt: "original", result: "done", at: new Date().toISOString() });
    const ui = await mount(options);
    await ui.key("z", { ctrl: true });
    expect(session.turns).toHaveLength(0);
    expect(events.setDraft).toHaveBeenCalledWith("original");
    expect(events.renderSessionTurns).toHaveBeenCalledWith(session);
  });

  it("Ctrl+Z leaves history alone during an active job", async () => {
    const { options, events, session } = fixture();
    session.turns.push({ prompt: "original", result: "done", at: new Date().toISOString() });
    options.jobs.current.set(session.id, {} as never);
    const ui = await mount(options);
    await ui.key("z", { ctrl: true });
    expect(session.turns).toHaveLength(1);
    expect(events.setDraft).not.toHaveBeenCalled();
  });

  it("conversation menu rewinds to the selected turn and restores its prompt", async () => {
    const { options, events, session } = fixture({ convoMenu: true, menuIndex: 1 });
    session.turns.push(
      { prompt: "first", result: "one", at: "2026-01-01T00:00:00Z" },
      { prompt: "second", result: "two", at: "2026-01-02T00:00:00Z" },
      { prompt: "third", result: "three", at: "2026-01-03T00:00:00Z" },
    );
    const ui = await mount(options);
    await ui.key("", { return: true });
    expect(events.setDraft).toHaveBeenCalledWith("second");
    expect(events.setConvoMenu).toHaveBeenCalledWith(false);
    expect(events.setHistory).toHaveBeenCalledWith(session.turns.map(turn => turn.prompt));
    expect(events.renderSessionTurns).toHaveBeenCalledWith(session);
  });

  it("conversation menu deletes only the selected turn", async () => {
    const { options, events, session } = fixture({ convoMenu: true, menuIndex: 1 });
    session.turns.push(
      { prompt: "first", result: "one", at: "2026-01-01T00:00:00Z" },
      { prompt: "second", result: "two", at: "2026-01-02T00:00:00Z" },
      { prompt: "third", result: "three", at: "2026-01-03T00:00:00Z" },
    );
    const ui = await mount(options);
    await ui.key("", { delete: true });
    expect(session.turns.map(turn => turn.prompt)).toEqual(["first", "third"]);
    expect(events.setHistory).toHaveBeenCalledWith(["first", "third"]);
    expect(events.setMenuIndex).toHaveBeenCalledWith(1);
  });

  it("conversation menu closes when its final turn is deleted", async () => {
    const { options, events, session } = fixture({ convoMenu: true });
    session.turns.push({ prompt: "only", result: "done", at: "2026-01-01T00:00:00Z" });
    const ui = await mount(options);
    await ui.key("d");
    expect(session.turns).toEqual([]);
    expect(events.setConvoMenu).toHaveBeenCalledWith(false);
  });

  it("conversation menu keeps the empty history unchanged on Enter", async () => {
    const { options, events } = fixture({ convoMenu: true });
    const ui = await mount(options);
    await ui.key("", { return: true });
    expect(events.setDraft).not.toHaveBeenCalled();
    expect(events.renderSessionTurns).not.toHaveBeenCalled();
  });
});
