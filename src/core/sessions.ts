import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { DEFAULT_CONFIG, EFFORTS, isRecord, parseConfig } from "../config.js";
import type { Config, Notice, Session } from "../types.js";
import type { Usage } from "@openai/codex-sdk";

function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  const record = value;
  return ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"].every(key => typeof record[key] === "number");
}

export function normalizeProject(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
export function projectKey(path: string): string {
  return createHash("sha256").update(normalizeProject(path)).digest("hex");
}
export function newSession(
  projectPath: string,
  mode: Session["routingMode"],
): Session {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectPath: normalizeProject(projectPath),
    createdAt: now,
    updatedAt: now,
    routingMode: mode,
    route: {},
    turns: [],
  };
}
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
function parseSession(value: unknown, project: string): Session | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.id) ||
    value.projectPath !== project ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.threadId !== undefined && typeof value.threadId !== "string") ||
    !Array.isArray(value.turns) ||
    !value.turns.every(
      (turn: unknown) =>
        isRecord(turn) &&
        typeof turn.prompt === "string" &&
        typeof turn.result === "string" &&
        typeof turn.at === "string" &&
        (turn.route === undefined || (isRecord(turn.route) && (turn.route.model === undefined || typeof turn.route.model === "string") && (turn.route.effort === undefined || EFFORTS.includes(turn.route.effort as (typeof EFFORTS)[number])))) &&
        (turn.usage === undefined || isUsage(turn.usage)) &&
        (turn.artifacts === undefined || (Array.isArray(turn.artifacts) && turn.artifacts.every((artifact: unknown) => typeof artifact === "string" && /^\.pace\/artifacts\/[^/\\]+\.md$/.test(artifact)))) &&
        (turn.failed === undefined || typeof turn.failed === "boolean"),
    ) ||
    !isRecord(value.route) ||
    (value.route.model !== undefined &&
      typeof value.route.model !== "string") ||
    (value.route.effort !== undefined &&
      !EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])) ||
    (value.routingMode !== "auto" && value.routingMode !== "manual")
  )
    return undefined;
  return value as Session;
}
export class PaceStore {
  constructor(
    readonly baseDir = join(homedir(), ".pace"),
    readonly notice: Notice = () => {},
  ) {}
  sessionDir(project: string): string {
    return join(this.baseDir, "sessions", projectKey(project));
  }
  async loadConfig(): Promise<Config> {
    try {
      return parseConfig(
        JSON.parse(await readFile(join(this.baseDir, "config.json"), "utf8")),
      );
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
    await atomicJson(
      join(this.sessionDir(session.projectPath), "active.json"),
      { id: session.id },
    );
  }
  async save(session: Session): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(session.id))
      throw new Error("Invalid Pace session ID");
    session.updatedAt = new Date().toISOString();
    await atomicJson(
      join(this.sessionDir(session.projectPath), `${session.id}.json`),
      session,
    );
    await this.activate(session);
  }
}
