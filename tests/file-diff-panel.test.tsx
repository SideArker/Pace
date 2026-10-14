import React from "react";
import { PassThrough, Writable } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileDiffPanel } from "../src/components/FileDiffPanel.js";
import { FileEdits } from "../src/core/file-edits.js";
import { newSession, PaceStore } from "../src/core/sessions.js";

type Input = (input: string, key: Partial<Record<string, boolean>>) => void;
let handler: Input;
vi.mock("ink", async original => ({ ...await original<typeof import("ink")>(), useInput: (input: Input) => { handler = input; } }));
class Output extends Writable {
  isTTY = true; columns = 100; rows = 25; writes: string[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) { this.writes.push(chunk.toString()); done(); }
}
let directory: string, project: string, store: PaceStore, session: ReturnType<typeof newSession>;
const instances: Array<ReturnType<typeof render>> = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pace-diff-ui-"));
  project = join(directory, "project"); await mkdir(project);
  store = new PaceStore(join(directory, "storage")); session = newSession(project, "manual");
  const edits = new FileEdits(store, session);
  await writeFile(join(project, "a.txt"), "before\n");
  const before = await edits.capture();
  await writeFile(join(project, "a.txt"), "after\n");
  await writeFile(join(project, "b.txt"), Array.from({ length: 70 }, (_, i) => `added line ${i}`).join("\n"));
  const id = await edits.record(before, await edits.capture());
  session.turns.push({ prompt: "Change two files", result: "done", at: new Date().toISOString(), fileEdits: id });
});
afterEach(async () => { for (const instance of instances.splice(0)) instance.unmount(); await rm(directory, { recursive: true, force: true }); });
async function mount() {
  const output = new Output();
  const onClose = vi.fn(), onChange = vi.fn();
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void };
  stdin.isTTY = true; stdin.setRawMode = () => {};
  const instance = render(<FileDiffPanel store={store} session={session} width={100} height={24} onClose={onClose} onChange={onChange} />, {
    stdin: stdin as unknown as ReadStream, stdout: output as unknown as WriteStream,
    stderr: new PassThrough() as unknown as WriteStream, patchConsole: false, alternateScreen: false, maxFps: 1000,
  });
  instances.push(instance);
  const frame = () => stripVTControlCharacters(output.writes.join(""));
  await vi.waitFor(() => expect(frame()).toContain("-before"));
  return { instance, onClose, onChange, frame, async key(input: string, flags: Partial<Record<string, boolean>> = {}) {
    output.writes.length = 0; handler(input, flags); await instance.waitUntilRenderFlush();
  } };
}

it("shows a colored patch and undoes and redoes the selected file from the keyboard", async () => {
  const ui = await mount();
  expect(ui.frame()).toContain("+after");
  expect(ui.frame()).toContain("Turn 1: Change two files");
  await ui.key("u");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledTimes(1));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("before\n");
  expect(await readFile(join(project, "b.txt"), "utf8")).toContain("added line 69");
  await vi.waitFor(() => expect(ui.frame()).toContain("undone a.txt"));
  await ui.key("r");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledTimes(2));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  await vi.waitFor(() => expect(ui.frame()).toContain("modified a.txt"));
  await ui.key("", { escape: true });
  expect(ui.onClose).toHaveBeenCalledOnce();
});

it("selects files and scrolls long patches without loading another file", async () => {
  const ui = await mount();
  await ui.key("", { downArrow: true });
  await vi.waitFor(() => expect(ui.frame()).toContain("+added line 0"));
  expect(ui.frame()).not.toContain("+added line 69");
  for (let i = 0; i < 8 && !ui.frame().includes("+added line 69"); i++) await ui.key("", { pageDown: true });
  expect(ui.frame()).toContain("+added line 69");
});

it("shows a conflict instead of overwriting a later manual edit", async () => {
  const ui = await mount();
  await writeFile(join(project, "a.txt"), "manual edit");
  await ui.key("u");
  await vi.waitFor(() => expect(ui.frame()).toContain("Cannot undo a.txt"));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("manual edit");
  expect(ui.onChange).not.toHaveBeenCalled();
});
