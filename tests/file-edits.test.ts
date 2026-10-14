import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginFileEdits, FileEdits, fileTurnActive } from "../src/core/file-edits.js";
import { changeConversationHistory, changeFileHistory } from "../src/core/file-history.js";
import { deleteConversationTurn, newSession, PaceStore, rewindConversation } from "../src/core/sessions.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { DEFAULT_CONFIG } from "../src/shared/config.js";

let dir: string, project: string, store: PaceStore, session: ReturnType<typeof newSession>, edits: FileEdits;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pace-edits-"));
  project = join(dir, "project");
  await mkdir(project);
  store = new PaceStore(join(dir, "storage"));
  session = newSession(project, "manual");
  edits = new FileEdits(store, session);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const file = (path: string) => join(project, path);
const text = (path: string) => readFile(file(path), "utf8");

it("restores edits, additions, deletions, binary data and executable permissions, then redoes them after reload", async () => {
  await writeFile(file("changed.txt"), "original\n");
  await writeFile(file("deleted.txt"), "keep me\n");
  await writeFile(file("binary"), Buffer.from([0, 1, 2]));
  await writeFile(file("run.sh"), "#!/bin/sh\n");
  await chmod(file("run.sh"), 0o644);
  const before = await edits.capture();
  await writeFile(file("changed.txt"), "edited\n");
  await rm(file("deleted.txt"));
  await mkdir(file("new"));
  await writeFile(file("new/created.txt"), "new\n");
  await writeFile(file("binary"), Buffer.from([0, 4, 5]));
  await chmod(file("run.sh"), 0o755);
  const id = (await edits.record(before, await edits.capture()))!;
  const record = await edits.load(id);
  expect(await edits.diff(record.changes.find(edit => edit.path === "changed.txt")!)).toContain("-original\n+edited");
  expect(await edits.diff(record.changes.find(edit => edit.path === "binary")!)).toContain("Binary file changed");
  expect(await edits.restore(id, "undo")).toBe(5);
  expect(await text("changed.txt")).toBe("original\n");
  expect(await text("deleted.txt")).toBe("keep me\n");
  await expect(lstat(file("new/created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(file("binary"))).toEqual(Buffer.from([0, 1, 2]));
  expect((await lstat(file("run.sh"))).mode & 0o777).toBe(0o644);
  const restored = new FileEdits(store, session);
  expect(await restored.restore(id, "redo")).toBe(5);
  expect(await text("changed.txt")).toBe("edited\n");
  expect(await text("new/created.txt")).toBe("new\n");
  expect((await lstat(file("run.sh"))).mode & 0o777).toBe(0o755);
});

it("preserves a dirty Git baseline and the index, and ignores ignored files", async () => {
  execFileSync("git", ["init", "-q", project]);
  await writeFile(file("tracked"), "staged baseline");
  execFileSync("git", ["-C", project, "add", "tracked"]);
  await writeFile(file("tracked"), "unstaged baseline");
  await writeFile(file("untracked"), "user file");
  await writeFile(file(".gitignore"), "ignored\n");
  await writeFile(file("ignored"), "before");
  const capture = await beginFileEdits(store, session);
  await writeFile(file("tracked"), "agent edit");
  await writeFile(file("ignored"), "after");
  const { id } = await capture.finish();
  expect(id).toBeDefined();
  expect((await edits.load(id!)).changes.map(edit => edit.path)).toEqual(["tracked"]);
  await edits.restore(id!, "undo");
  expect(await text("tracked")).toBe("unstaged baseline");
  expect(execFileSync("git", ["-C", project, "show", ":tracked"], { encoding: "utf8" })).toBe("staged baseline");
  expect(await text("untracked")).toBe("user file");
  expect(await text("ignored")).toBe("after");
});

it.each(["reveal", "hide"])("does not misidentify existing files when ignore rules change (%s)", async mode => {
  execFileSync("git", ["init", "-q", project]);
  await mkdir(file("cache"));
  await writeFile(file("cache/existing"), "user cache");
  await writeFile(file("user.txt"), "user file");
  await writeFile(file(".gitignore"), mode === "reveal" ? "user.txt\ncache/\n" : "");
  const capture = await beginFileEdits(store, session);
  await writeFile(file(".gitignore"), mode === "reveal" ? "" : "user.txt\ncache/\n");
  if (mode === "hide") await writeFile(file("user.txt"), "agent edit");
  const { id } = await capture.finish();
  const paths = (await edits.load(id!)).changes.map(edit => edit.path);
  expect(paths).toEqual(mode === "hide" ? [".gitignore", "user.txt"] : [".gitignore"]);
  await edits.restore(id!, "undo");
  expect(await text("user.txt")).toBe("user file");
  expect(await text("cache/existing")).toBe("user cache");
  await edits.restore(id!, "redo");
  expect(await text("user.txt")).toBe(mode === "hide" ? "agent edit" : "user file");
});

it("refuses the entire restore when one file was manually edited", async () => {
  await writeFile(file("a"), "old"); await writeFile(file("b"), "old");
  const before = await edits.capture();
  await writeFile(file("a"), "agent"); await writeFile(file("b"), "agent");
  const id = (await edits.record(before, await edits.capture()))!;
  await writeFile(file("b"), "manual");
  await expect(edits.restore(id, "undo")).rejects.toThrow("file changed since this edit");
  expect(await text("a")).toBe("agent"); expect(await text("b")).toBe("manual");
  expect((await edits.load(id)).changes.every(edit => !edit.undone)).toBe(true);
});

it("undoes one file without changing the other edits", async () => {
  const before = await edits.capture();
  await writeFile(file("a"), "one"); await writeFile(file("b"), "two");
  const id = (await edits.record(before, await edits.capture()))!;
  session.threadId = "old-thread";
  await changeFileHistory(store, session, id, "undo", "a");
  await expect(text("a")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await text("b")).toBe("two");
  expect(session.threadId).toBeUndefined();
  await changeFileHistory(store, session, id, "redo", "a");
  expect(await text("a")).toBe("one");
});

it("undoes and redoes conversation turns together with their files", async () => {
  await writeFile(file("a"), "user baseline");
  const before = await edits.capture();
  await writeFile(file("a"), "agent");
  const id = (await edits.record(before, await edits.capture()))!;
  session.turns.push({ prompt: "edit", result: "done", at: new Date().toISOString(), fileEdits: id });
  session.threadId = "thread";
  expect((await changeConversationHistory(store, session, "undo"))?.files).toBe(1);
  expect(session.turns).toHaveLength(0);
  expect(session.undoneTurns).toHaveLength(1);
  const reloaded = (await store.load(project, session.id))!;
  expect(reloaded.undoneTurns?.[0]?.fileEdits).toBe(id);
  expect(session.threadId).toBeUndefined();
  expect(await text("a")).toBe("user baseline");
  expect((await changeConversationHistory(store, reloaded, "redo"))?.files).toBe(1);
  expect(reloaded.turns.at(-1)?.fileEdits).toBe(id);
  expect(await text("a")).toBe("agent");
});

it("rolls files and edit flags back when session persistence fails", async () => {
  const before = await edits.capture();
  await writeFile(file("a"), "agent");
  const id = (await edits.record(before, await edits.capture()))!;
  session.turns.push({ prompt: "edit", result: "done", at: new Date().toISOString(), fileEdits: id });
  vi.spyOn(store, "save").mockRejectedValue(new Error("disk full"));
  await expect(changeConversationHistory(store, session, "undo")).rejects.toThrow("disk full");
  expect(await text("a")).toBe("agent");
  expect((await edits.load(id)).changes[0]?.undone).toBe(false);
  expect(session.turns).toHaveLength(1);
});

it("validates every saved blob before changing any file", async () => {
  await writeFile(file("a"), "old a"); await writeFile(file("b"), "old b");
  const before = await edits.capture();
  await writeFile(file("a"), "new a"); await writeFile(file("b"), "new b");
  const id = (await edits.record(before, await edits.capture()))!;
  const record = await edits.load(id);
  await writeFile(join(store.sessionDir(project), "edit-blobs", record.changes[1]!.before!.hash), "corrupt");
  await expect(edits.restore(id, "undo")).rejects.toThrow("corrupt");
  expect(await text("a")).toBe("new a"); expect(await text("b")).toBe("new b");
});

it("invalidates redo when the conversation is rewound or a turn is deleted", () => {
  const turn = { prompt: "old", result: "done", at: new Date().toISOString() };
  session.turns.push(turn); session.undoneTurns = [turn];
  rewindConversation(session, 0);
  expect(session.undoneTurns).toBeUndefined();
  session.turns.push(turn); session.undoneTurns = [turn];
  deleteConversationTurn(session, 0);
  expect(session.undoneTurns).toBeUndefined();
});

it("captures project files even if the store directory is an ancestor of the project", async () => {
  const nestedStore = new PaceStore(dir);
  const nested = new FileEdits(nestedStore, session);
  await writeFile(file("a"), "before");
  const before = await nested.capture();
  await writeFile(file("a"), "after");
  const id = (await nested.record(before, await nested.capture()))!;
  await nested.restore(id, "undo");
  expect(await text("a")).toBe("before");
});

it("restores symlinks without touching their targets and rejects a symlinked parent", async () => {
  await writeFile(join(dir, "outside"), "outside");
  await symlink(join(dir, "outside"), file("link"));
  const before = await edits.capture();
  await rm(file("link")); await writeFile(file("link"), "regular");
  const id = (await edits.record(before, await edits.capture()))!;
  await edits.restore(id, "undo");
  expect(await readlink(file("link"))).toBe(join(dir, "outside"));
  expect(await readFile(join(dir, "outside"), "utf8")).toBe("outside");
  await mkdir(file("nested"));
  const base = await edits.capture();
  await writeFile(file("nested/a"), "agent");
  const nested = (await edits.record(base, await edits.capture()))!;
  await rm(file("nested"), { recursive: true });
  await symlink(dir, file("nested"));
  await expect(edits.restore(nested, "undo")).rejects.toThrow("Edit parent is not a directory");
});

it("keeps concurrent conversations running but skips ambiguous file undo", async () => {
  const first = await beginFileEdits(store, session);
  const second = await beginFileEdits(store, newSession(project, "manual"));
  expect(fileTurnActive(project)).toBe(true);
  await expect(edits.restore("none", "undo")).rejects.toThrow("Wait for running turns");
  expect((await first.finish()).skipped).toContain("overlapped");
  expect((await second.finish()).skipped).toContain("overlapped");
  expect(fileTurnActive(project)).toBe(false);
});

it.each([false, true])("records completed and failed Codex edits (failure: %s) and invalidates redo on new work", async failure => {
  session.route = { model: "gpt-6-sol", effort: "high" };
  const config = { ...DEFAULT_CONFIG, skillFolder: null };
  const orchestrator = new Orchestrator(store, { async run() {
    await writeFile(file("agent.txt"), "changed by runner");
    if (failure) throw new Error("runner failed after editing");
    return { result: "done", completed: true, threadId: "thread" };
  } });
  session.undoneTurns = [{ prompt: "old redo", result: "old", at: new Date().toISOString() }];
  const turn = orchestrator.turn("edit", session, config, () => {});
  if (failure) await expect(turn).rejects.toThrow("runner failed");
  else await turn;
  expect(session.turns.at(-1)?.fileEdits).toMatch(/^[0-9a-f-]{36}$/);
  expect(session.undoneTurns).toBeUndefined();
  const loaded = (await store.load(project, session.id))!;
  await changeConversationHistory(store, loaded, "undo");
  await expect(text("agent.txt")).rejects.toMatchObject({ code: "ENOENT" });
  await changeConversationHistory(store, loaded, "redo");
  expect(await text("agent.txt")).toBe("changed by runner");
});

it("retains each failed retry that made file edits so all attempts can be undone", async () => {
  session.route = { model: "gpt-6-sol", effort: "high" };
  let attempt = 0;
  const orchestrator = new Orchestrator(store, { async run() {
    await writeFile(file("partial"), `attempt ${++attempt}`);
    throw new Error("failed after editing");
  } });
  for (let i = 0; i < 2; i++) await expect(orchestrator.turn("edit", session, { ...DEFAULT_CONFIG, skillFolder: null }, () => {})).rejects.toThrow("failed after editing");
  expect(session.turns).toHaveLength(2);
  await changeConversationHistory(store, session, "undo");
  expect(await text("partial")).toBe("attempt 1");
  await changeConversationHistory(store, session, "undo");
  await expect(text("partial")).rejects.toMatchObject({ code: "ENOENT" });
});
