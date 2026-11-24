import React from "react";
import { PassThrough, Writable } from "node:stream";
import { createRequire } from "node:module";
import type { ReadStream, WriteStream } from "node:tty";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileDiffPanel, parseDiffRows } from "../src/components/FileDiffPanel.js";
import { beginFileEdits, FileEdits } from "../src/core/file-edits.js";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { getTheme } from "../src/shared/colors.js";

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
async function mount(props: Partial<React.ComponentProps<typeof FileDiffPanel>> = {}) {
  const output = new Output();
  const onClose = vi.fn(), onChange = vi.fn(), onComment = vi.fn(async () => {});
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const instance = render(<FileDiffPanel store={store} session={session} width={100} height={24} onClose={onClose} onChange={onChange} isActive={() => false} onComment={onComment} {...props} />, {
    stdin: stdin as unknown as ReadStream, stdout: output as unknown as WriteStream,
    stderr: new PassThrough() as unknown as WriteStream, patchConsole: false, alternateScreen: false, maxFps: 1000,
  });
  instances.push(instance);
  const frame = () => stripVTControlCharacters(output.writes.join(""));
  await vi.waitFor(() => expect(frame()).toMatch(/--- |No saved file edits|No file changes/));
  return { instance, onClose, onChange, onComment, frame, raw: () => output.writes.join(""), async key(input: string, flags: Partial<Record<string, boolean>> = {}) {
    output.writes.length = 0;
    const sequence = flags.escape ? "\x1b" : flags.downArrow ? "\x1b[B" : flags.upArrow ? "\x1b[A"
      : flags.leftArrow ? "\x1b[D" : flags.rightArrow ? "\x1b[C" : flags.pageDown ? "\x1b[6~"
      : flags.pageUp ? "\x1b[5~" : flags.return ? "\r" : flags.tab ? "\t" : input;
    stdin.write(sequence);
    await new Promise(resolve => setImmediate(resolve)); await instance.waitUntilRenderFlush();
  } };
}

it("shows a colored patch and rejects and undoes the selected file from the keyboard", async () => {
  const ui = await mount();
  expect(ui.frame()).toContain("+after");
  expect(ui.frame()).toContain("All file changes in this conversation so far.");
  await ui.key("r");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledTimes(1));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("before\n");
  expect(await readFile(join(project, "b.txt"), "utf8")).toContain("added line 69");
  await vi.waitFor(() => expect(ui.frame()).toContain("1/1 files · b.txt"));
  await ui.key("u");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledTimes(2));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  await vi.waitFor(() => expect(ui.frame()).toContain("a.txt"));
  await ui.key("", { escape: true });
  await vi.waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
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
  await ui.key("r");
  await vi.waitFor(() => expect(ui.frame()).toContain("Cannot undo a.txt"));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("manual edit");
  expect(ui.onChange).not.toHaveBeenCalled();
});

it("accepts a file without touching its contents or thread, and persists undo across reopening", async () => {
  session.threadId = "existing-thread";
  const turns = structuredClone(session.turns);
  const ui = await mount();
  await ui.key("a");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledOnce());
  const id = session.turns[0]!.fileEdits!;
  expect(session.fileReviews?.[id]?.["a.txt"]).toBe("accepted");
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  expect(session.threadId).toBe("existing-thread");
  expect(session.turns).toEqual(turns);
  ui.instance.unmount();
  session = (await store.load(project, session.id))!;
  const reopened = await mount();
  await reopened.key("u");
  await vi.waitFor(() => expect(reopened.onChange).toHaveBeenCalledOnce());
  expect(session.fileReviews?.[id]?.["a.txt"]).toBeUndefined();
  expect(session.lastFileReview).toBeUndefined();
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
});

it.each(["A", "R"])("requires confirmation for %s on the entire conversation and undoes the decision", async key => {
  const ui = await mount();
  const turns = structuredClone(session.turns);
  await ui.key(key, { shift: true });
  expect(ui.frame()).toContain("all 2 files in this conversation?");
  expect(ui.onChange).not.toHaveBeenCalled();
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  await ui.key("n");
  expect(ui.onChange).not.toHaveBeenCalled();
  await ui.key(key);
  await ui.key("", { escape: true });
  await vi.waitFor(() => expect(ui.frame()).toContain("a accept file"));
  expect(ui.onClose).not.toHaveBeenCalled();
  await ui.key(key);
  await ui.key("y");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledOnce());
  const id = session.turns[0]!.fileEdits!;
  expect(Object.values(session.fileReviews![id]!)).toEqual([key === "A" ? "accepted" : "rejected", key === "A" ? "accepted" : "rejected"]);
  expect(session.turns).toEqual(turns);
  if (key === "R") {
    expect(await readFile(join(project, "a.txt"), "utf8")).toBe("before\n");
    await expect(readFile(join(project, "b.txt"))).rejects.toThrow();
  }
  await ui.key("u");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledTimes(2));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  expect(await readFile(join(project, "b.txt"), "utf8")).toContain("added line 69");
  expect(Object.keys(session.fileReviews![id]!)).toEqual([]);
});

it("rolls back both files and review metadata when saving the conversation decision fails", async () => {
  const ui = await mount();
  const save = vi.spyOn(store, "saveChanges").mockRejectedValueOnce(new Error("disk full"));
  await ui.key("R"); await ui.key("y");
  await vi.waitFor(() => expect(ui.frame()).toContain("disk full"));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  expect(await readFile(join(project, "b.txt"), "utf8")).toContain("added line 69");
  expect(session.fileReviews).toBeUndefined();
  expect(session.lastFileReview).toBeUndefined();
  expect((await new FileEdits(store, session).load(session.turns[0]!.fileEdits!)).changes.every(edit => !edit.undone)).toBe(true);
  expect(ui.onChange).not.toHaveBeenCalled();
  save.mockRestore();
});

it("rejects no files when any file in the conversation conflicts", async () => {
  const ui = await mount();
  await writeFile(join(project, "b.txt"), "manual edit");
  await ui.key("R"); await ui.key("y");
  await vi.waitFor(() => expect(ui.frame()).toContain("Cannot undo b.txt"));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  expect(await readFile(join(project, "b.txt"), "utf8")).toBe("manual edit");
  expect(session.fileReviews).toBeUndefined();
});

it("blocks Accept/Reject/Undo for an active agent while retaining browsing and comments", async () => {
  const ui = await mount({ isActive: () => true });
  for (const key of ["a", "r", "u", "A", "R"]) await ui.key(key);
  expect(ui.onChange).not.toHaveBeenCalled();
  expect(session.fileReviews).toBeUndefined();
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  await ui.key("", { downArrow: true });
  await vi.waitFor(() => expect(ui.frame()).toContain("+added line 0"));
  await ui.key("c");
  await vi.waitFor(() => expect(ui.frame()).toContain("Select a line"));
  await ui.key("c");
  await vi.waitFor(() => expect(ui.frame()).toContain("Comment to agent"));
  await ui.key("Please add a regression test");
  await vi.waitFor(() => expect(ui.frame()).toContain("Please add a regression test"));
  await ui.key("", { return: true });
  await vi.waitFor(() => expect(ui.onComment).toHaveBeenCalledExactlyOnceWith("Review comment for conversation, file b.txt, new line 1:\nCode: +added line 0\n\nPlease add a regression test"));
  await ui.key("", { escape: true });
  await vi.waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
});

it("uses the project snapshot lock even if the job state has not rerendered", async () => {
  const ui = await mount();
  const active = await beginFileEdits(store, session);
  try {
    for (const key of ["a", "r", "u"]) await ui.key(key);
    expect(ui.onChange).not.toHaveBeenCalled();
    expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  } finally { await active.finish(); }
});

it("shows empty history and still supports comments and Escape", async () => {
  session.turns[0]!.fileEdits = "none";
  const ui = await mount();
  expect(ui.frame()).toContain("No saved file edits");
  for (const key of ["a", "r", "u"]) await ui.key(key);
  expect(ui.onChange).not.toHaveBeenCalled();
  await ui.key("c");
  await vi.waitFor(() => expect(ui.frame()).toContain("Comment to agent"));
  await ui.key("Inspect the workspace");
  await vi.waitFor(() => expect(ui.frame()).toContain("Inspect the workspace"));
  await ui.key("", { return: true });
  await vi.waitFor(() => expect(ui.onComment).toHaveBeenCalledWith("Review comment:\nInspect the workspace"));
  await ui.key("", { escape: true });
  await vi.waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
});

it("explains why an older conversation has no saved edits when its capture was skipped", async () => {
  session.turns[0]!.fileEdits = undefined;
  session.turns[0]!.systemMessages = ["File undo unavailable: conversations overlapped in this project."];
  const ui = await mount();
  expect(ui.frame()).toContain("No saved file edits");
  expect(ui.frame()).toContain("File undo unavailable: conversations overlapped in this project.");
});

it("undoes a rejected file after reloading the saved conversation", async () => {
  const ui = await mount();
  await ui.key("r");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledOnce());
  ui.instance.unmount();
  session = (await store.load(project, session.id))!;
  const reopened = await mount();
  await reopened.key("u");
  await vi.waitFor(() => expect(reopened.onChange).toHaveBeenCalledOnce());
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  expect(session.turns).toHaveLength(1);
});

it("undoes only the files changed by the last decision in a partially reviewed conversation", async () => {
  const ui = await mount();
  await ui.key("r");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(ui.frame()).toContain("1/1 files · b.txt"));
  await ui.key("R"); await ui.key("y");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledTimes(2));
  await ui.key("u");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledTimes(3));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("before\n");
  expect(await readFile(join(project, "b.txt"), "utf8")).toContain("added line 69");
  expect(session.fileReviews?.[session.turns[0]!.fileEdits!]).toEqual({ "a.txt": "rejected" });
});

it("refuses undo when the restored file has since changed, keeping the decision available", async () => {
  const ui = await mount();
  await ui.key("r");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(ui.frame()).toContain("1/1 files · b.txt"));
  await writeFile(join(project, "a.txt"), "new manual edit");
  await ui.key("u");
  await vi.waitFor(() => expect(ui.frame()).toContain("Cannot redo a.txt"));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("new manual edit");
  expect(session.lastFileReview?.restoredPaths).toEqual(["a.txt"]);
  expect(ui.onChange).toHaveBeenCalledOnce();
});

it("rechecks active work when a conversation-wide confirmation is submitted", async () => {
  let running = false;
  const ui = await mount({ isActive: () => running });
  await ui.key("R");
  await vi.waitFor(() => expect(ui.frame()).toContain("Reject all 2 files"));
  running = true;
  await ui.key("y");
  await vi.waitFor(() => expect(ui.frame()).toContain("Wait for running work"));
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
  expect(ui.onChange).not.toHaveBeenCalled();
});

it.each([undefined, "planning"] as const)("uses Pace colors for each file status and diff lines without filename prefixes (theme: %s)", async kind => {
  session.kind = kind;
  const chalk = (await import(createRequire(import.meta.resolve("ink")).resolve("chalk"))).default;
  const previousLevel = chalk.level;
  chalk.level = 3;
  try {
    const edits = new FileEdits(store, session);
    await writeFile(join(project, "deleted.txt"), "removed file\n");
    await writeFile(join(project, "old.ts"), "moved content\n");
    const before = await edits.capture();
    await rm(join(project, "deleted.txt"));
    await writeFile(join(project, "renamed.ts"), "moved content\n");
    await rm(join(project, "old.ts"));
    const id = await edits.record(before, await edits.capture());
    session.turns.push({ prompt: "Delete a file", result: "done", at: "now", fileEdits: id });
    const ui = await mount();
    const theme = getTheme(session.kind);
    expect(ui.raw()).toContain(chalk.hex(theme.error)("-before"));
    expect(ui.raw()).toContain(chalk.hex(theme.success)("+after"));
    expect(ui.raw()).toMatch(/\x1b\[38;2;248;113;113m[^\x1b\n]*deleted\.txt/);
    expect(ui.raw()).toMatch(/\x1b\[38;2;52;211;153m[^\x1b\n]*b\.txt/);
    expect(ui.raw()).toMatch(/\x1b\[38;2;251;191;36m[^\x1b\n]*a\.txt/);
    expect(ui.raw()).toMatch(/\x1b\[38;2;56;189;248m[^\x1b\n]*renamed\.ts/);
    for (const prefix of ["modified a.txt", "added b.txt", "deleted deleted.txt"])
      expect(ui.frame()).not.toContain(prefix);
  } finally { chalk.level = previousLevel; }
});

it("combines earlier and later files and shows the full diff for a file changed twice", async () => {
  const edits = new FileEdits(store, session);
  const before = await edits.capture();
  await writeFile(join(project, "a.txt"), "latest content\n");
  await writeFile(join(project, "c.txt"), "newest file\n");
  const id = await edits.record(before, await edits.capture());
  session.turns.push({ prompt: "Change a again and add c", result: "done", at: "now", fileEdits: id });
  const ui = await mount();
  expect(ui.frame()).toContain("1/3 files");
  expect(ui.frame()).toMatch(/\n\s+b\.txt\s+│/);
  expect(ui.frame()).toMatch(/\n\s+c\.txt\s+│/);
  expect(ui.frame()).toContain("-before");
  expect(ui.frame()).toContain("+latest content");
  expect(ui.frame()).not.toContain("+after");
  expect(ui.frame()).not.toContain("[/] turn");
  await ui.key("["); await ui.key("]");
  await ui.key("r");
  await vi.waitFor(() => expect(ui.onChange).toHaveBeenCalledOnce());
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("before\n");
  expect(await readFile(join(project, "c.txt"), "utf8")).toBe("newest file\n");
  await vi.waitFor(() => expect(ui.frame()).toContain("1/2 files"));
  ui.instance.unmount();
  session = (await store.load(project, session.id))!;
  const reopened = await mount();
  await reopened.key("u");
  await vi.waitFor(() => expect(reopened.onChange).toHaveBeenCalledOnce());
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("latest content\n");
  expect(session.turns).toHaveLength(2);
  await reopened.key("", { rightArrow: true });
  await vi.waitFor(() => expect(reopened.onClose).toHaveBeenCalledOnce());
});

it.each([60, 100, 140])("renders file names to the left of a persistent divider at width %s", async width => {
  const ui = await mount({ width });
  const rows = ui.frame().split("\n");
  const heading = rows.find(row => row.includes("Files") && row.includes("Diff"))!;
  expect(heading).toBeDefined();
  const divider = heading.indexOf("│");
  expect(divider).toBeGreaterThan(heading.indexOf("Files"));
  expect(divider / width).toBeGreaterThanOrEqual(0.15);
  expect(divider / width).toBeLessThanOrEqual(0.20);
  expect(heading.indexOf("Diff")).toBeGreaterThan(divider);
  const fileRow = rows.find(row => row.includes("a.txt") && row.includes("--- a/a.txt"))!;
  expect(fileRow).toBeDefined();
  expect(fileRow.slice(0, divider).trim()).toBe("❯ a.txt");
  expect(fileRow[divider]).toBe("│");
  expect(fileRow.slice(divider + 1)).toContain("--- a/a.txt");
  expect(rows.find(row => row.includes("-before"))![divider]).toBe("│");
  expect(ui.frame()).toContain("→/Esc chat");
});

it.each([false, true])("Right returns to chat with empty history while active: %s", async active => {
  session.turns[0]!.fileEdits = "none";
  const ui = await mount({ isActive: () => active });
  await ui.key("", { rightArrow: true });
  await vi.waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
  expect(ui.onChange).not.toHaveBeenCalled();
  expect(session.turns).toHaveLength(1);
});

it("Right dismisses conversation-wide confirmation without applying the decision", async () => {
  const ui = await mount();
  await ui.key("R");
  await vi.waitFor(() => expect(ui.frame()).toContain("Reject all 2 files"));
  await ui.key("", { rightArrow: true });
  await vi.waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
  expect(ui.onChange).not.toHaveBeenCalled();
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("after\n");
});

it("refreshes the combined diff while the active agent changes files", async () => {
  const capture = await beginFileEdits(store, session);
  const ui = await mount();
  try {
    await writeFile(join(project, "a.txt"), "live content\n");
    await writeFile(join(project, "0-live.txt"), "new live file\n");
    await vi.waitFor(() => {
      expect(ui.frame()).toContain("0-live.txt");
      expect(ui.frame()).toContain("+live content");
      expect(ui.frame()).toContain("2/3 files · a.txt");
    }, { timeout: 4000 });
    expect(ui.frame()).toContain("-before");
    expect(ui.onChange).not.toHaveBeenCalled();
  } finally { ui.instance.unmount(); await capture.finish(); }
});

it("shows overlapping edits during the first turn and after reopening, with browsing and comments available", async () => {
  session.turns = [];
  const first = await beginFileEdits(store, session);
  const second = await beginFileEdits(store, newSession(project, "manual"));
  await writeFile(join(project, "a.txt"), "overlapping content\n");
  let ui: Awaited<ReturnType<typeof mount>> | undefined;
  let recorded: Awaited<ReturnType<typeof first.finish>>;
  try {
    ui = await mount();
    expect(ui.frame()).toContain("+overlapping content");
    expect(ui.frame()).toContain("Workspace changes · overlapping conversations");
    expect(ui.frame()).toContain("Accept/Reject/Undo disabled");
  } finally {
    ui?.instance.unmount();
    recorded = await first.finish();
    await second.finish();
  }
  session.turns.push({ prompt: "Change a", result: "done", at: "now", fileEdits: recorded.id });
  await store.saveChanges(session);
  session = (await store.load(project, session.id))!;
  const reopened = await mount();
  expect(reopened.frame()).toContain("+overlapping content");
  expect(reopened.frame()).toContain("attribution unavailable");
  for (const key of ["a", "r", "u", "A", "R"]) await reopened.key(key);
  expect(reopened.onChange).not.toHaveBeenCalled();
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("overlapping content\n");
  await reopened.key("c"); await reopened.key("c");
  await vi.waitFor(() => expect(reopened.frame()).toContain("Comment to agent"));
  await reopened.key("Check this diff"); await reopened.key("", { return: true });
  await vi.waitFor(() => expect(reopened.onComment).toHaveBeenCalledOnce());
  await reopened.key("", { rightArrow: true });
  expect(reopened.onClose).toHaveBeenCalledOnce();
});

it("numbers old and new source lines across hunks without numbering patch metadata", () => {
  const rows = parseDiffRows("--- a/x\n+++ b/x\n@@ -10,3 +20,4 @@\n same\n-old\n+new\n+extra\n end\n\\ No newline at end of file\n@@ -100 +200 @@\n---source\n+++source");
  expect(rows.slice(0, 3).every(row => row.oldLine === undefined && row.newLine === undefined)).toBe(true);
  expect(rows.slice(3, 8).map(({ oldLine, newLine }) => [oldLine, newLine])).toEqual([
    [10, 20], [11, undefined], [undefined, 21], [undefined, 22], [12, 23],
  ]);
  expect(rows[8]).toMatchObject({ kind: "meta" });
  expect(rows[10]).toMatchObject({ oldLine: 100, kind: "deletion" });
  expect(rows[11]).toMatchObject({ newLine: 200, kind: "addition" });
  expect(parseDiffRows("@@ -0,0 +1,2 @@\n+one\n+two").slice(1).map(row => [row.oldLine, row.newLine])).toEqual([[undefined, 1], [undefined, 2]]);
});

it.each([" ", "\r"])("Enter/Space focuses the diff so arrows select lines instead of files: %j", async input => {
  const ui = await mount();
  await ui.key("", { downArrow: true });
  await vi.waitFor(() => expect(ui.frame()).toContain("+added line 0"));
  await ui.key(input);
  await vi.waitFor(() => expect(ui.frame()).toContain("← files"));
  await ui.key("", { downArrow: true });
  expect(ui.frame()).toContain("2/2 files · b.txt");
  expect(ui.frame()).toContain("new 2");
  await ui.key("", { pageDown: true });
  expect(ui.frame()).toContain("new 16");
  expect(ui.onClose).not.toHaveBeenCalled();
  await ui.key("", { leftArrow: true });
  await ui.key("", { upArrow: true });
  await vi.waitFor(() => expect(ui.frame()).toContain("1/2 files · a.txt"));
  await ui.key("", { rightArrow: true });
  await vi.waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
});

it.each([false, true])("comments on a selected source line with its side, number and excerpt (addition: %s)", async addition => {
  const ui = await mount();
  await ui.key("c");
  await vi.waitFor(() => expect(ui.frame()).toContain("Select a line"));
  if (addition) await ui.key("", { downArrow: true });
  await ui.key("c");
  await vi.waitFor(() => expect(ui.frame()).toContain("Comment to agent"));
  await ui.key("Please check this line"); await ui.key("", { return: true });
  await vi.waitFor(() => expect(ui.onComment).toHaveBeenCalledExactlyOnceWith(
    `Review comment for conversation, file a.txt, ${addition ? "new" : "old"} line 1:\nCode: ${addition ? "+after" : "-before"}\n\nPlease check this line`,
  ));
});

it("freezes the comment target while active edits refresh behind the editor", async () => {
  const capture = await beginFileEdits(store, session);
  const ui = await mount();
  try {
    await ui.key("c"); await ui.key("", { downArrow: true }); await ui.key("c");
    await vi.waitFor(() => expect(ui.frame()).toContain("Comment to agent"));
    await ui.key("Check the original selection");
    await writeFile(join(project, "a.txt"), "revised\nsecond line\n");
    await vi.waitFor(() => expect(ui.frame()).toContain("+revised"), { timeout: 4000 });
    await ui.key("", { return: true });
    await vi.waitFor(() => expect(ui.onComment).toHaveBeenCalledExactlyOnceWith(
      "Review comment for conversation, file a.txt, new line 1:\nCode: +after\n\nCheck the original selection",
    ));
  } finally { ui.instance.unmount(); await capture.finish(); }
});
