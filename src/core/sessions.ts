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
const keyedRecords = new Set(["attempts", "sideAnswers", "controlDecisions"]);

export class SessionConflictError extends Error {
  constructor(readonly field: string) {
    super(`Session changed concurrently (${field}); reload and reapply the intended change`);
    this.name = "SessionConflictError";
  }
}

/** Apply only the caller's changes; concurrent edits to the same value fail closed. */
function reapplyChanges(base: unknown, desired: unknown, latest: unknown, field: string): unknown {
  if (isDeepStrictEqual(base, desired)) return structuredClone(latest);
  if (isDeepStrictEqual(base, latest) || isDeepStrictEqual(desired, latest)) return structuredClone(desired);
  if (keyedRecords.has(field) && (base === undefined || Array.isArray(base)) &&
      Array.isArray(desired) && Array.isArray(latest)) {
    const records = (items: unknown[]): Map<string, unknown> => {
      const result = new Map<string, unknown>();
      for (const item of items) {
        if (!isRecord(item) || typeof item.id !== "string" || result.has(item.id)) throw new SessionConflictError(field);
        result.set(item.id, item);
      }
      return result;
    };
    const before = records(base ?? []), after = records(desired), current = records(latest);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (isDeepStrictEqual(before.get(id), after.get(id))) continue;
      if (!isDeepStrictEqual(before.get(id), current.get(id)) && !isDeepStrictEqual(after.get(id), current.get(id)))
        throw new SessionConflictError(`${field}.${id}`);
      if (after.has(id)) current.set(id, structuredClone(after.get(id)));
      else current.delete(id);
    }
    return [...current.values()];
  }
  if (isRecord(base) && isRecord(desired) && isRecord(latest)) {
    const result = structuredClone(latest);
    for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
      const value = reapplyChanges(base[key], desired[key], latest[key], field ? `${field}.${key}` : key);
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
    return result;
  }
  throw new SessionConflictError(field);
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
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      const session = parseSession(raw, normalizeProject(project));
      if (session) this.track(session);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.notice(`Session ${sessionId} unavailable: ${String(error)}`);
      return undefined;
    }
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
      try {
        const session = parseSession(
          JSON.parse(await readFile(join(path, file), "utf8")),
          normalizeProject(project),
        );
        if (session) { this.track(session); sessions.push(session); }
        else this.notice(`Ignoring invalid session ${file}`);
      } catch {
        this.notice(`Ignoring unreadable session ${file}`);
      }
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
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      // Keep mutations made while this write waited in the queue for their next save.
      if (key !== "revision" && key !== "updatedAt" && !isDeepStrictEqual(target[key], before[key])) continue;
      if (isDeepStrictEqual(target[key], after[key])) continue;
      if (keyedRecords.has(key) && Array.isArray(target[key]) && Array.isArray(after[key])) {
        const existing = new Map((target[key] as Record<string, unknown>[]).map(record => [record.id, record]));
        target[key] = (after[key] as Record<string, unknown>[]).map(record => {
          const current = existing.get(record.id);
          return isDeepStrictEqual(current, record) ? current : structuredClone(record);
        });
      } else if (Object.hasOwn(after, key)) target[key] = structuredClone(after[key]);
      else delete target[key];
    }
    objectBaselines.set(caller, structuredClone(saved));
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
    const captured = structuredClone(session);
    const baseline = objectBaselines.get(session) ?? revisionBaselines.get(`${this.key(captured)}:${captured.revision ?? 0}`);
    await this.serial(captured, async () => {
      const latest = await this.readSaved(captured);
      if (!latest) {
        if ((captured.revision ?? 0) !== 0) throw new SessionConflictError("revision");
        const saved = await this.write(captured, 0, activate);
        this.refreshCaller(session, captured, saved);
        return;
      }
      if (!baseline) throw new SessionConflictError("unknown snapshot baseline");
      const base = structuredClone(baseline), desired = structuredClone(captured);
      // Metadata belongs to the store, not to a user change.
      desired.revision = base.revision;
      desired.updatedAt = base.updatedAt;
      const merged = reapplyChanges(base, desired, latest, "") as Session;
      const saved = await this.write(merged, latest.revision ?? 0, activate);
      this.refreshCaller(session, captured, saved);
    });
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
