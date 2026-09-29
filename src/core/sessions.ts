import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
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
import { parseSession } from "./session-record.js";
export { normalizeProject, projectKey, newSession, rewindConversation, deleteConversationTurn, undoConversationTurn } from "./session-model.js";

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
export class PaceStore {
  private activationQueue: Promise<void> = Promise.resolve();
  constructor(
    readonly baseDir = join(homedir(), ".pace"),
    readonly notice: Notice = () => {},
  ) {}
  sessionDir(project: string): string {
    return join(this.baseDir, "sessions", projectKey(project));
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
        if (session) sessions.push(session);
        else this.notice(`Ignoring invalid session ${file}`);
      } catch {
        this.notice(`Ignoring unreadable session ${file}`);
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async listProjects(): Promise<{ projectPath: string; exists: boolean; sessions: Session[] }[]> {
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
              !parseSession(value, normalizeProject(value.projectPath))) continue;
          const projectPath = normalizeProject(value.projectPath);
          const sessions = await this.list(projectPath);
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
  async save(session: Session, activate: boolean | (() => boolean) = true): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(session.id))
      throw new Error("Invalid Pace session ID");
    session.updatedAt = new Date().toISOString();
    await atomicJson(
      join(this.sessionDir(session.projectPath), `${session.id}.json`),
      session,
    );
    if (typeof activate === "function" ? activate() : activate) await this.activate(session);
  }
}
