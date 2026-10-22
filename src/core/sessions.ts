import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { DEFAULT_CONFIG, isRecord, parseConfig } from "../shared/config.js";
import type { Config, Notice, Session } from "../shared/types.js";
import { normalizeProject, projectKey } from "./session-model.js";
import { parseSession, parseSessionSummary } from "./session-record.js";
import { keyedRecords, reapplyChanges, SessionConflictError } from "./sessions-revisions.js";
export { SessionConflictError } from "./sessions-revisions.js";
export { normalizeProject, projectKey, newSession, rewindConversation, deleteConversationTurn, undoConversationTurn, retryableTurn } from "./session-model.js";
export { parseSessionSummary } from "./session-record.js";

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
type Activation = boolean | (() => boolean);
type SessionIdentity = Pick<Session, "id" | "projectPath">;
const writeQueues = new Map<string, Promise<unknown>>();
const objectBaselines = new WeakMap<Session, Session>();
const revisionBaselines = new Map<string, Session>();
const activeAttempts = new Set<string>();

function attemptKey(session: SessionIdentity, attemptId: string): string {
  return `${resolve(session.projectPath)}:${session.id}:${attemptId}`;
}
export function registerActiveAttempt(session: SessionIdentity, attemptId: string): () => void {
  const key = attemptKey(session, attemptId);
  activeAttempts.add(key);
  return () => activeAttempts.delete(key);
}
export function isActiveAttempt(session: SessionIdentity, attemptId: string): boolean {
  return activeAttempts.has(attemptKey(session, attemptId));
}

export class PaceStore {
  private activationQueue: Promise<void> = Promise.resolve();
  constructor(
    readonly baseDir = join(homedir(), ".pace"),
    readonly notice: Notice = () => {},
  ) {}
  sessionDir(project: string): string {
    return join(this.baseDir, "sessions", projectKey(project));
  }
  conversationDir(project: string, sessionId: string): string {
    return join(this.sessionDir(project), sessionId);
  }
  async saveFeedback(session: Session, comment = ""): Promise<string> {
    const capturedAt = new Date().toISOString();
    const id = randomUUID();
    const file = `${capturedAt.replace(/[:.]/g, "-")}-${id}.json`;
    const directory = join(this.baseDir, "feedback", "inbox");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, file);
    await atomicJson(path, {
      version: 1,
      id,
      capturedAt,
      comment,
      projectPath: session.projectPath,
      session: structuredClone(session),
    });
    return path;
  }
  async loadConfig(): Promise<Config> {
    try {
      const config = parseConfig(
        JSON.parse(await readFile(join(this.baseDir, "config.json"), "utf8")),
      );
      // An untouched config from older Pace versions meant "use the SDK default".
      if (config.routingMode === "auto" && !config.models.length && !config.defaultRoute.model)
        return structuredClone(DEFAULT_CONFIG);
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(DEFAULT_CONFIG);
      this.notice(`Config unavailable: ${String(error)}`);
      throw error;
    }
  }
  async saveConfig(config: Config): Promise<void> {
    await atomicJson(join(this.baseDir, "config.json"), parseConfig(config));
  }
  async load(project: string, sessionId: string): Promise<Session | undefined> {
    const path = join(this.sessionDir(project), `${sessionId}.json`);
    let session: Session | undefined;
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      session = parseSession(raw, normalizeProject(project));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.notice(`Session ${sessionId} unavailable: ${String(error)}`);
      return undefined;
    }
    if (session) {
      this.track(session);
      await this.recoverInterruptedAttempts(session, false);
    }
    return session;
  }
  async list(project: string): Promise<Session[]> {
    const path = this.sessionDir(project);
    let files: string[];
    try {
      files = await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.notice(`Sessions unavailable: ${String(error)}`);
      return [];
    }
    const sessions: Session[] = [];
    for (const file of files.filter((name) =>
      /^[0-9a-f-]{36}\.json$/.test(name),
    )) {
      let session: Session | undefined;
      try {
        session = parseSession(
          JSON.parse(await readFile(join(path, file), "utf8")),
          normalizeProject(project),
        );
      } catch {
        this.notice(`Ignoring unreadable session ${file}`);
        continue;
      }
      if (session) {
        this.track(session);
        await this.recoverInterruptedAttempts(session, false);
        sessions.push(session);
      } else this.notice(`Ignoring invalid session ${file}`);
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async listSummaries(project: string): Promise<Session[]> {
    const path = this.sessionDir(project);
    let files: string[];
    try {
      files = await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.notice(`Sessions unavailable: ${String(error)}`);
      return [];
    }
    const sessions: Session[] = [];
    for (const file of files.filter((name) =>
      /^[0-9a-f-]{36}\.json$/.test(name),
    )) {
      try {
        const session = parseSessionSummary(
          JSON.parse(await readFile(join(path, file), "utf8")),
          normalizeProject(project),
        );
        if (session) sessions.push(session);
        else this.notice(`Ignoring invalid session ${file}`);
      } catch {
        this.notice(`Ignoring unreadable session ${file}`);
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async listProjects(options?: { summariesOnly?: boolean }): Promise<{ projectPath: string; exists: boolean; sessions: Session[] }[]> {
    const root = join(this.baseDir, "sessions");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.notice(`Projects unavailable: ${String(error)}`);
      return [];
    }
    const projects: { projectPath: string; exists: boolean; sessions: Session[] }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      let files: string[];
      try {
        files = await readdir(join(root, entry.name));
      } catch {
        continue;
      }
      for (const file of files.filter(name => /^[0-9a-f-]{36}\.json$/.test(name))) {
        try {
          const value: unknown = JSON.parse(await readFile(join(root, entry.name, file), "utf8"));
          if (!isRecord(value) || typeof value.projectPath !== "string" ||
              projectKey(value.projectPath) !== entry.name ||
              !parseSessionSummary(value, normalizeProject(value.projectPath))) continue;
          const projectPath = normalizeProject(value.projectPath);
          const sessions = options?.summariesOnly
            ? await this.listSummaries(projectPath)
            : await this.list(projectPath);
          const exists = await stat(projectPath).then(info => info.isDirectory()).catch(() => false);
          projects.push({ projectPath, exists, sessions });
          break;
        } catch {
          /* Another session in the directory may still be valid. */
        }
      }
    }
    return projects.sort((a, b) =>
      (b.sessions[0]?.updatedAt ?? "").localeCompare(a.sessions[0]?.updatedAt ?? ""));
  }
  /** Move sessions from a missing project path to an existing project directory.
   * The original directory is retained outside session discovery as a rollback copy. */
  async reconnectProject(from: string, to: string): Promise<number> {
    const oldProject = normalizeProject(from);
    const newProject = normalizeProject(to);
    if (oldProject === newProject) throw new Error("Choose a different project path");
    if (await stat(oldProject).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    })) throw new Error("The original project path still exists");
    if (!await stat(newProject).then(info => info.isDirectory()).catch(() => false))
      throw new Error("The new project path must be an existing directory");
    const source = this.sessionDir(oldProject);
    const target = this.sessionDir(newProject);
    if (await stat(target).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    })) throw new Error("The new project already has saved sessions");
    const files = await readdir(source);
    const sessionFiles = files.filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    if (!sessionFiles.length) throw new Error("No saved sessions at the original project path");
    const sessions: Session[] = [];
    for (const file of sessionFiles) {
      const value: unknown = JSON.parse(await readFile(join(source, file), "utf8"));
      const session = parseSession(value, oldProject);
      if (!session || `${session.id}.json` !== file) throw new Error(`Invalid saved session: ${file}`);
      sessions.push({ ...session, projectPath: newProject });
    }
    let activeId: string | undefined;
    if (files.includes("active.json")) {
      const active: unknown = JSON.parse(await readFile(join(source, "active.json"), "utf8"));
      if (!isRecord(active) || typeof active.id !== "string" || !sessions.some(item => item.id === active.id))
        throw new Error("Invalid active session at the original project path");
      activeId = active.id;
    }
    const root = join(this.baseDir, "sessions");
    const staged = join(root, `.reconnect-${randomUUID()}`);
    const archiveRoot = join(this.baseDir, "reconnected");
    const archive = join(archiveRoot, `${projectKey(oldProject)}-${randomUUID()}`);
    await mkdir(staged, { recursive: true });
    try {
      for (const session of sessions) {
        await atomicJson(join(staged, `${session.id}.json`), session);
        const convoDir = join(source, session.id);
        if (await stat(convoDir).then(s => s.isDirectory()).catch(() => false)) {
          await cp(convoDir, join(staged, session.id), { recursive: true });
        }
      }
      if (activeId) await atomicJson(join(staged, "active.json"), { id: activeId });
      await mkdir(archiveRoot, { recursive: true });
      await rename(source, archive);
      try {
        await rename(staged, target);
      } catch (error) {
        await rename(archive, source);
        throw error;
      }
      return sessions.length;
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
    }
  }
  async latest(project: string): Promise<Session | undefined> {
    const sessions = await this.list(project);
    try {
      const active: unknown = JSON.parse(
        await readFile(join(this.sessionDir(project), "active.json"), "utf8"),
      );
      if (isRecord(active) && typeof active.id === "string")
        return sessions.find((s) => s.id === active.id) ?? sessions[0];
    } catch {
      /* Fall back to the newest session. */
    }
    return sessions[0];
  }
  /** A running record with no live owner belongs to a previous Pace process or a stopped run. */
  async recoverInterruptedAttempts(session: Session, activate: Activation = false): Promise<boolean> {
    const interrupted = (session.attempts ?? []).filter(attempt =>
      ["running", "awaiting_user"].includes(attempt.status) && !isActiveAttempt(session, attempt.id));
    if (!interrupted.length) return false;
    const finishedAt = new Date().toISOString();
    for (const attempt of interrupted) {
      attempt.status = "failed";
      attempt.finishedAt = finishedAt;
      attempt.error ??= "Pace stopped before this execution's final state was saved; continue from the saved thread and observations.";
      if ((attempt.role === "main" || attempt.role === "scout") && session.activeTask?.id === attempt.taskId) {
        session.activeTask.assessment = "unknown";
        if (session.activeTask.workflow) {
          session.activeTask.workflow.status = "pending";
          session.activeTask.workflow.needsAssessment = true;
        }
      }
    }
    await this.saveChanges(session, activate);
    return true;
  }
  async activate(session: Session): Promise<void> {
    const write = () => atomicJson(
      join(this.sessionDir(session.projectPath), "active.json"),
      { id: session.id },
    );
    const pending = this.activationQueue.then(write, write);
    this.activationQueue = pending.catch(() => {});
    await pending;
  }
  private key(session: SessionIdentity): string {
    if (!/^[0-9a-f-]{36}$/.test(session.id)) throw new Error("Invalid Pace session ID");
    return resolve(this.sessionDir(session.projectPath), `${session.id}.json`);
  }
  private track(session: Session): void {
    const baseline = structuredClone(session);
    objectBaselines.set(session, baseline);
    const key = `${this.key(session)}:${session.revision ?? 0}`;
    revisionBaselines.set(key, baseline);
    // Spread copies carry a revision; retain a bounded cache of their source snapshots.
    while (revisionBaselines.size > 2000) revisionBaselines.delete(revisionBaselines.keys().next().value!);
  }
  private async readSaved(identity: SessionIdentity): Promise<Session | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.key(identity), "utf8"));
      const session = parseSession(value, normalizeProject(identity.projectPath));
      if (!session || session.id !== identity.id) throw new Error("Saved Pace session is invalid");
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async serial<T>(identity: SessionIdentity, operation: () => Promise<T>): Promise<T> {
    const key = this.key(identity);
    const previous = writeQueues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    writeQueues.set(key, pending);
    try { return await pending; }
    finally { if (writeQueues.get(key) === pending) writeQueues.delete(key); }
  }
  private async write(session: Session, revision: number, activate: Activation): Promise<Session> {
    session.revision = revision + 1;
    session.updatedAt = new Date().toISOString();
    // Track exactly the JSON shape readers see, including legacy normalization.
    const persisted = parseSession(JSON.parse(JSON.stringify(session)), normalizeProject(session.projectPath));
    if (!persisted) throw new Error("Cannot save invalid Pace session");
    await atomicJson(this.key(persisted), persisted);
    this.track(persisted);
    if (typeof activate === "function" ? activate() : activate) await this.activate(persisted);
    return persisted;
  }
  private refreshCaller(caller: Session, captured: Session, saved: Session): void {
    const target = caller as unknown as Record<string, unknown>;
    const before = captured as unknown as Record<string, unknown>;
    const after = saved as unknown as Record<string, unknown>;
    const baseline = structuredClone(saved) as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      let value = after[key];
      if (key !== "revision" && key !== "updatedAt" && !isDeepStrictEqual(target[key], before[key])) {
        // Preserve edits made during I/O AND independent records merged from
        // disk. Keeping the whole local array would delete unseen records on
        // the next save, because its baseline already contains those records.
        const [baseValue, localValue, savedValue] = [before[key], target[key], after[key]]
          .map(item => item === undefined ? undefined : JSON.parse(JSON.stringify(item)));
        try { value = reapplyChanges(baseValue, localValue, savedValue, key); }
        catch (error) {
          if (!(error instanceof SessionConflictError)) throw error;
          // The write already committed. Retain the conflicting local intent
          // and its original baseline so a later save still fails closed.
          if (Object.hasOwn(before, key)) baseline[key] = structuredClone(before[key]);
          else delete baseline[key];
          continue;
        }
      }
      if (isDeepStrictEqual(target[key], value)) continue;
      if (keyedRecords.has(key) && Array.isArray(target[key]) && Array.isArray(value)) {
        const existing = new Map((target[key] as Record<string, unknown>[]).map(record => [record.id, record]));
        target[key] = (value as Record<string, unknown>[]).map(record => {
          const current = existing.get(record.id);
          return isDeepStrictEqual(current, record) ? current : structuredClone(record);
        });
      } else if (value !== undefined) target[key] = structuredClone(value);
      else delete target[key];
    }
    objectBaselines.set(caller, baseline as unknown as Session);
  }
  /** Strict whole-snapshot write. Stale snapshots are never merged implicitly. */
  async save(session: Session, activate: Activation = true): Promise<void> {
    const captured = structuredClone(session);
    await this.serial(captured, async () => {
      const latest = await this.readSaved(captured);
      if ((captured.revision ?? 0) !== (latest?.revision ?? 0)) throw new SessionConflictError("revision");
      const saved = await this.write(captured, latest?.revision ?? 0, activate);
      this.refreshCaller(session, captured, saved);
    });
  }
  /** Reapply a tracked snapshot's concrete changes on the newest persisted revision. */
  async saveChanges(session: Session, activate: Activation = true): Promise<void> {
    await this.serial(session, async () => {
      // Earlier writes may refresh this same object. Capture its state and
      // baseline together only after those writes finish, including on failure.
      const captured = structuredClone(session);
      const baseline = objectBaselines.get(session) ?? revisionBaselines.get(`${this.key(captured)}:${captured.revision ?? 0}`);
      const latest = await this.readSaved(captured);
      if (!latest) {
        if ((captured.revision ?? 0) !== 0) throw new SessionConflictError("revision");
        const saved = await this.write(captured, 0, activate);
        this.refreshCaller(session, captured, saved);
        return;
      }
      if (!baseline) throw new SessionConflictError("unknown snapshot baseline");
      // Compare the JSON values that will actually be persisted. Optional
      // undefined properties inside arrays are not edits to saved records.
      const base = structuredClone(baseline), desired = JSON.parse(JSON.stringify(captured)) as Session;
      // Metadata belongs to the store, not to a user change.
      desired.revision = base.revision;
      desired.updatedAt = base.updatedAt;
      const merged = reapplyChanges(base, desired, latest, "") as Session;
      const saved = await this.write(merged, latest.revision ?? 0, activate);
      this.refreshCaller(session, captured, saved);
    });
  }
  /** Preserve a rejected snapshot before returning a fresh, usable caller. */
  async recoverConflict(session: Session): Promise<{ session: Session; snapshotPath: string }> {
    const recovery = await this.serial(session, async () => {
      const latest = await this.readSaved(session);
      if (!latest) throw new Error("Pace session not found");
      const snapshotPath = join(this.conversationDir(session.projectPath, session.id), "recovery", `${randomUUID()}.json`);
      await atomicJson(snapshotPath, session);
      this.track(latest);
      return { session: latest, snapshotPath };
    });
    await this.recoverInterruptedAttempts(recovery.session, false);
    return recovery;
  }
  /** Serialized latest-state mutation, including callers using independent store instances. */
  async update(identity: SessionIdentity, mutate: (latest: Session) => void | Promise<void>, activate: Activation = true): Promise<Session> {
    return this.serial(identity, async () => {
      const latest = await this.readSaved(identity);
      if (!latest) throw new Error("Pace session not found");
      const revision = latest.revision ?? 0;
      await mutate(latest);
      if (latest.id !== identity.id || latest.projectPath !== normalizeProject(identity.projectPath))
        throw new Error("Session update cannot change identity");
      return this.write(latest, revision, activate);
    });
  }
}
