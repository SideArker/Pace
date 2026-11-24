import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { atomicJson, type PaceStore } from "./sessions.js";
import type { Session } from "../shared/types.js";

const exec = promisify(execFile);
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const uuid = /^[0-9a-f-]{36}$/;
const excluded = new Set([".git", ".pace", "node_modules", "dist", "build", ".next", ".venv", "__pycache__"]);
type ActiveCapture = { overlapped: boolean; sessionId: string; before?: Snapshot };
const active = new Map<string, Set<ActiveCapture>>();
const restoring = new Map<string, Promise<void>>();
type FileState = { hash: string; mode: number; kind: "file" | "symlink" };
type Snapshot = { files: Map<string, FileState>; ignored: string[] };
export type FileEdit = { path: string; before?: FileState; after?: FileState; undone: boolean };
export type FileEditRecord = { version: 1; project: string; changes: FileEdit[]; overlapped?: boolean };
export type ConversationFileEdit = FileEdit & { review?: "accepted"; previousPath?: string };
export type ConversationEdits = Omit<FileEditRecord, "changes"> & { changes: ConversationFileEdit[] };
type RestoreStep = { id: string; direction: "undo" | "redo"; paths?: string[] };
const same = (a?: FileState, b?: FileState) => a?.hash === b?.hash && a?.mode === b?.mode && a?.kind === b?.kind;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export function fileTurnActive(project: string): boolean { return !!active.get(resolve(project))?.size; }

/** Overlapping workspace changes remain visible, but cannot safely be restored. */
export async function beginFileEdits(store: PaceStore, session: Session) {
  const project = resolve(session.projectPath);
  while (restoring.has(project)) await restoring.get(project);
  const token: ActiveCapture = { overlapped: false, sessionId: session.id };
  const turns = active.get(project) ?? new Set<ActiveCapture>();
  if (turns.size) { token.overlapped = true; for (const turn of turns) turn.overlapped = true; }
  turns.add(token);
  active.set(project, turns);
  const close = () => { turns.delete(token); if (!turns.size) active.delete(project); };
  const edits = new FileEdits(store, session);
  try {
    const before = await edits.capture();
    token.before = before;
    return {
      async finish(): Promise<{ id?: string; skipped?: string }> {
        try {
          const after = await edits.capture(before);
          const id = await edits.record(before, after, token);
          return { id, ...(token.overlapped ? { skipped: "File undo unavailable: conversations overlapped in this project. Workspace changes remain visible in review." } : {}) };
        } finally { close(); }
      },
    };
  } catch (error) { close(); throw error; }
}

export class FileEdits {
  readonly project: string;
  private readonly directory: string;
  private readonly blobs: string;
  private readonly excludedStorage: string;
  constructor(private readonly store: PaceStore, session: Pick<Session, "projectPath" | "id">) {
    this.project = resolve(session.projectPath);
    this.directory = join(store.conversationDir(this.project, session.id), "edits");
    this.blobs = join(store.sessionDir(this.project), "edit-blobs");
    const base = resolve(store.baseDir);
    this.excludedStorage = this.project === base || this.project.startsWith(base + sep) ? join(base, "sessions") : base;
  }
  private path(path: string): string {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === ".." || part === "." || part === ".git"))
      throw new Error(`Unsafe edit path: ${path}`);
    const target = resolve(this.project, path);
    if (relative(this.project, target).startsWith(`..${sep}`)) throw new Error(`Unsafe edit path: ${path}`);
    return target;
  }
  private async checkParents(path: string): Promise<void> {
    let parent = dirname(this.path(path));
    while (parent !== this.project) {
      try {
        const info = await lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Edit parent is not a directory: ${relative(this.project, parent)}`);
      } catch (error) { if (!missing(error)) throw error; }
      parent = dirname(parent);
    }
  }
  private async state(path: string): Promise<{ state: FileState; data: Buffer } | undefined> {
    await this.checkParents(path);
    const target = this.path(path);
    try {
      const info = await lstat(target);
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Not a regular file: ${path}`);
      if (info.size > 8 * 1024 * 1024) throw new Error(`File exceeds 8 MiB snapshot limit: ${path}`);
      const data = info.isSymbolicLink() ? Buffer.from(await readlink(target)) : await readFile(target);
      return { state: { hash: hash(data), mode: info.mode & 0o777, kind: info.isSymbolicLink() ? "symlink" : "file" }, data };
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  private async blob(data: Buffer): Promise<string> {
    await mkdir(this.blobs, { recursive: true, mode: 0o700 });
    const digest = hash(data);
    try { await writeFile(join(this.blobs, digest), data, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return digest;
  }
  private async data(state?: FileState): Promise<Buffer> {
    if (!state) return Buffer.alloc(0);
    const data = await readFile(join(this.blobs, state.hash));
    if (hash(data) !== state.hash) throw new Error("Saved edit content is corrupt; no files restored.");
    return data;
  }
  private async files(): Promise<{ files: string[]; ignored: string[] }> {
    try {
      const [included, ignored] = await Promise.all([
        exec("git", ["-C", this.project, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { maxBuffer: 8 * 1024 * 1024 }),
        exec("git", ["-C", this.project, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "--", "."], { maxBuffer: 8 * 1024 * 1024 }),
      ]);
      return { files: [...new Set(included.stdout.split("\0").filter(Boolean))], ignored: ignored.stdout.split("\0").filter(Boolean) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !String((error as { stderr?: string }).stderr).includes("not a git repository")) throw error;
      const files: string[] = [];
      const visit = async (folder: string) => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (excluded.has(entry.name)) continue;
          const path = join(folder, entry.name);
          if (resolve(path) === this.excludedStorage) continue;
          if (entry.isDirectory()) await visit(path);
          else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(this.project, path));
          if (files.length > 10_000) throw new Error("Project exceeds 10,000 snapshot files.");
        }
      };
      await visit(this.project);
      return { files, ignored: [] };
    }
  }
  async capture(baseline?: Snapshot): Promise<Snapshot> {
    const listed = await this.files();
    const ignored = baseline?.ignored ?? listed.ignored;
    const wasIgnored = (path: string) => ignored.some(item => item.endsWith("/") ? path.startsWith(item) : path === item);
    const files = [...new Set([...listed.files, ...(baseline?.files.keys() ?? [])])]
      .filter(path => baseline?.files.has(path) || !wasIgnored(path));
    if (files.length > 10_000) throw new Error("Project exceeds 10,000 snapshot files.");
    const snapshot = new Map<string, FileState>();
    let size = 0;
    for (const path of files) {
      const target = this.path(path);
      if (target === this.excludedStorage || target.startsWith(this.excludedStorage + sep)) continue;
      // Git lists submodules as directories. Their contents belong to a different repository.
      try { if ((await lstat(target)).isDirectory()) continue; } catch (error) { if (!missing(error)) throw error; }
      const file = await this.state(path);
      if (!file) continue;
      size += file.data.length;
      if (size > 64 * 1024 * 1024) throw new Error("Project exceeds 64 MiB snapshot limit.");
      await this.blob(file.data);
      snapshot.set(path, file.state);
    }
    return { files: snapshot, ignored };
  }
  private async changes(before: Snapshot, after: Snapshot): Promise<FileEdit[]> {
    // Ignore rules can change mid-turn. A missing listing entry is not necessarily a deletion.
    for (const path of before.files.keys()) {
      if (after.files.has(path)) continue;
      const current = await this.state(path);
      if (current) { await this.blob(current.data); after.files.set(path, current.state); }
    }
    const changes = [...new Set([...before.files.keys(), ...after.files.keys()])].sort()
      .filter(path => before.files.has(path) || !before.ignored.some(item => item.endsWith("/") ? path.startsWith(item) : path === item))
      .filter(path => !same(before.files.get(path), after.files.get(path)))
      .map(path => ({ path, before: before.files.get(path), after: after.files.get(path), undone: false }));
    return changes;
  }
  async record(before: Snapshot, after: Snapshot, capture?: { overlapped: boolean }): Promise<string | undefined> {
    const changes = await this.changes(before, after);
    if (!changes.length) return undefined;
    const id = randomUUID();
    await atomicJson(join(this.directory, `${id}.json`), { version: 1, project: this.project, changes, ...(capture?.overlapped ? { overlapped: true } : {}) });
    return id;
  }
  async conversation(session: Session): Promise<ConversationEdits> {
    const combined = new Map<string, FileEdit & { review?: "accepted" }>();
    let overlapped = false;
    const merge = (changes: FileEdit[], id?: string) => {
      for (const edit of changes) {
        let file = combined.get(edit.path);
        if (!file) {
          file = { path: edit.path, before: edit.before, after: edit.before, undone: false, review: "accepted" };
          combined.set(edit.path, file);
        }
        if (edit.undone) continue;
        file.after = edit.after;
        if (!id || session.fileReviews?.[id]?.[edit.path] !== "accepted") file.review = undefined;
      }
    };
    for (const turn of session.turns) {
      if (turn.fileEdits && turn.fileEdits !== "none") {
        const record = await this.load(turn.fileEdits);
        overlapped ||= !!record.overlapped;
        merge(record.changes, turn.fileEdits);
      }
    }
    for (const capture of active.get(this.project) ?? []) {
      if (capture.sessionId !== session.id || !capture.before) continue;
      const changes = await this.changes(capture.before, await this.capture(capture.before));
      overlapped ||= capture.overlapped;
      merge(changes);
    }
    const changes = [...combined.values()].filter(edit => !same(edit.before, edit.after));
    const removed = new Map<string, ConversationFileEdit[]>(), added = new Map<string, ConversationFileEdit[]>();
    for (const edit of changes) {
      if (edit.before && edit.after) continue;
      const state = (edit.before ?? edit.after)!;
      const key = `${state.kind}:${state.hash}`;
      const group = edit.before ? removed : added;
      const files = group.get(key) ?? [];
      files.push(edit); group.set(key, files);
    }
    const paired = new Set<string>();
    const moves: ConversationFileEdit[] = [];
    for (const [key, sources] of removed) {
      const targets = added.get(key);
      if (sources.length !== 1 || targets?.length !== 1) continue;
      const source = sources[0]!, target = targets[0]!;
      paired.add(source.path); paired.add(target.path);
      moves.push({ ...target, before: source.before, previousPath: source.path,
        review: source.review === "accepted" && target.review === "accepted" ? "accepted" : undefined });
    }
    return { version: 1, project: this.project, ...(overlapped ? { overlapped: true } : {}), changes: [...changes.filter(edit => !paired.has(edit.path)), ...moves]
      .sort((a, b) => a.path.localeCompare(b.path)) };
  }

  async load(id: string): Promise<FileEditRecord> {
    if (!uuid.test(id)) throw new Error("Invalid file edit record.");
    const record: FileEditRecord = JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8"));
    const validState = (value: FileState | undefined) => value === undefined || (value !== null && /^[a-f0-9]{64}$/.test(value.hash) &&
      Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777 && ["file", "symlink"].includes(value.kind));
    if (record.version !== 1 || record.project !== this.project || (record.overlapped !== undefined && typeof record.overlapped !== "boolean") || !Array.isArray(record.changes) || record.changes.length > 10_000 ||
      !record.changes.every(edit => edit && typeof edit.path === "string" && typeof edit.undone === "boolean" &&
        validState(edit.before) && validState(edit.after) && (edit.before || edit.after))) throw new Error("Invalid file edit record.");
    for (const edit of record.changes) this.path(edit.path);
    if (new Set(record.changes.map(edit => edit.path)).size !== record.changes.length) throw new Error("Duplicate saved edit path.");
    return record;
  }
  private async write(path: string, state: FileState | undefined, data: Buffer): Promise<void> {
    await this.checkParents(path);
    const target = this.path(path);
    if (!state) { await rm(target, { force: true }); return; }
    await mkdir(dirname(target), { recursive: true });
    const temp = join(dirname(target), `.pace-edit-${randomUUID()}`);
    try {
      if (state.kind === "symlink") await symlink(data.toString(), temp);
      else { await writeFile(temp, data, { mode: state.mode, flag: "wx" }); await chmod(temp, state.mode); }
      await rename(temp, target);
    } finally { await rm(temp, { force: true }); }
  }
  async restore(id: string, direction: "undo" | "redo", paths?: string[], commit?: () => Promise<void>): Promise<number> {
    return this.restoreSequence([{ id, direction, paths }], commit);
  }
  async restoreSequence(steps: RestoreStep[], commit?: () => Promise<void>): Promise<number> {
    if (fileTurnActive(this.project)) throw new Error("Wait for running turns in this project before changing files.");
    if (restoring.has(this.project)) throw new Error("Another file history change is in progress.");
    let release!: () => void;
    restoring.set(this.project, new Promise<void>(resolve => { release = resolve; }));
    try { return await this.restoreFiles(steps, commit); }
    finally { restoring.delete(this.project); release(); }
  }
  private async restoreFiles(steps: RestoreStep[], commit?: () => Promise<void>): Promise<number> {
    const records = new Map<string, { record: FileEditRecord; flags: boolean[] }>();
    type Contents = Awaited<ReturnType<FileEdits["state"]>>;
    const originals = new Map<string, Contents>();
    const prepared = new Map<string, Contents>();
    let count = 0;
    // Simulate all restores before writing, including files touched by several turns.
    for (const { id, direction, paths } of steps) {
      if (!records.has(id)) {
        const record = await this.load(id);
        if (record.overlapped) throw new Error("Cannot restore workspace changes from overlapping conversations.");
        records.set(id, { record, flags: record.changes.map(edit => edit.undone) });
      }
      const { record } = records.get(id)!;
      for (const edit of record.changes.filter(edit => edit.undone === (direction === "redo") && (!paths || paths.includes(edit.path)))) {
        if (!originals.has(edit.path)) originals.set(edit.path, await this.state(edit.path));
        const current = prepared.has(edit.path) ? prepared.get(edit.path) : originals.get(edit.path);
        const expected = edit.undone ? edit.before : edit.after;
        if (!same(current?.state, expected)) throw new Error(`Cannot ${direction} ${edit.path}: file changed since this edit. No files changed.`);
        const state = direction === "undo" ? edit.before : edit.after;
        prepared.set(edit.path, state ? { state, data: await this.data(state) } : undefined);
        edit.undone = direction === "undo";
        count++;
      }
    }
    const applied: string[] = [], saved: string[] = [];
    try {
      for (const [path, contents] of prepared) {
        await this.write(path, contents?.state, contents?.data ?? Buffer.alloc(0)); applied.push(path);
      }
      for (const [id, { record }] of records) {
        await atomicJson(join(this.directory, `${id}.json`), record); saved.push(id);
      }
      await commit?.();
    } catch (error) {
      const failures = [];
      for (const path of applied.reverse()) {
        const original = originals.get(path);
        try { await this.write(path, original?.state, original?.data ?? Buffer.alloc(0)); }
        catch { failures.push(path); }
      }
      for (const id of saved) {
        const { record, flags } = records.get(id)!;
        record.changes.forEach((edit, index) => { edit.undone = flags[index]!; });
        try { await atomicJson(join(this.directory, `${id}.json`), record); }
        catch { failures.push("saved edit record"); }
      }
      if (failures.length) throw new Error(`Edit restore failed; could not roll back: ${failures.join(", ")}. ${String(error)}`);
      throw error;
    }
    return count;
  }
  async diff(edit: FileEdit & { previousPath?: string }): Promise<string> {
    const before = await this.data(edit.before);
    const after = await this.data(edit.after);
    const header = `${edit.before ? `--- a/${edit.previousPath ?? edit.path}` : "--- /dev/null"}\n${edit.after ? `+++ b/${edit.path}` : "+++ /dev/null"}`;
    if (before.includes(0) || after.includes(0)) return `${header}\nBinary file changed`;
    const old = await this.blob(before), next = await this.blob(after);
    let output: string;
    try { output = (await exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", join(this.blobs, old), join(this.blobs, next)], { maxBuffer: 20 * 1024 * 1024 })).stdout; }
    catch (error) {
      if ((error as { code?: number }).code === 1) output = String((error as { stdout: string }).stdout);
      else if ((error as NodeJS.ErrnoException).code === "ENOENT") output = `@@ -1,${before.toString().split("\n").length} +1,${after.toString().split("\n").length} @@\n${before.toString().split("\n").map(line => `-${line}`).join("\n")}\n${after.toString().split("\n").map(line => `+${line}`).join("\n")}`;
      else throw error;
    }
    let hunk = output.indexOf("@@");
    if (hunk < 0 && edit.previousPath && after.length) {
      const lines = after.toString().split("\n");
      if (lines.at(-1) === "") lines.pop();
      output = `@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map(line => ` ${line}`).join("\n")}`;
      hunk = 0;
    }
    const mode = edit.before?.mode !== edit.after?.mode ? `\nmode ${edit.before?.mode.toString(8) ?? "absent"} → ${edit.after?.mode.toString(8) ?? "absent"}` : "";
    const kind = edit.before && edit.after && edit.before.kind !== edit.after.kind ? `\ntype ${edit.before.kind} → ${edit.after.kind}` : "";
    return `${header}${mode}${kind}\n${hunk < 0 ? "No text changes" : output.slice(hunk).replace(/\n$/, "")}`;
  }
}
