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
import { DEFAULT_CONFIG, EFFORTS, isRecord, parseConfig } from "../shared/config.js";
import type { Config, Notice, Session } from "../shared/types.js";
import type { Usage } from "@openai/codex-sdk";

function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  const record = value;
  return ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"].every(key => typeof record[key] === "number");
}
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function isStage(value: unknown): boolean {
  return isRecord(value) && typeof value.objective === 'string' && isRecord(value.route) &&
    (value.route.model === undefined || typeof value.route.model === 'string') &&
    (value.route.effort === undefined || EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])) &&
    nonnegative(value.durationMs) && (value.usage === undefined || isUsage(value.usage)) &&
    (value.estimatedCostUsd === undefined || nonnegative(value.estimatedCostUsd)) &&
    (value.handoff === undefined || (typeof value.handoff === 'string' && value.handoff.length <= 20_000));
}
function isRouting(value: unknown): boolean {
  return isRecord(value) && typeof value.objective === 'string' && typeof value.choice === 'string' &&
    nonnegative(value.confidence) && (value.confidence as number) <= 1 && isRecord(value.probabilities) &&
    Object.values(value.probabilities).every(probability => nonnegative(probability) && (probability as number) <= 1) &&
    Number.isInteger(value.attempts) && (value.attempts as number) >= 0;
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
    activeSkills: [],
    skillOptions: {},
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
        (turn.routeNote === undefined || typeof turn.routeNote === "string") &&
        (turn.durationMs === undefined || (typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs) && turn.durationMs >= 0)) &&
        (turn.usage === undefined || isUsage(turn.usage)) &&
        (turn.estimatedCostUsd === undefined || nonnegative(turn.estimatedCostUsd)) &&
        (turn.stages === undefined || (Array.isArray(turn.stages) && turn.stages.every(isStage))) &&
        (turn.routing === undefined || (Array.isArray(turn.routing) && turn.routing.every(isRouting))) &&
        (turn.artifacts === undefined || (Array.isArray(turn.artifacts) && turn.artifacts.every((artifact: unknown) => typeof artifact === "string" && /^\.pace\/artifacts\/[^/\\]+\.md$/.test(artifact)))) &&
        (turn.failed === undefined || typeof turn.failed === "boolean"),
    ) ||
    !isRecord(value.route) ||
    (value.route.model !== undefined &&
      typeof value.route.model !== "string") ||
    (value.route.effort !== undefined &&
      !EFFORTS.includes(value.route.effort as (typeof EFFORTS)[number])) ||
    (value.activeSkills !== undefined && (!Array.isArray(value.activeSkills) ||
      !value.activeSkills.every((name: unknown) => typeof name === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(name)))) ||
    (value.skillOptions !== undefined && (!isRecord(value.skillOptions) ||
      !Object.entries(value.skillOptions).every(([name, option]) => /^[a-z0-9][a-z0-9_-]*$/i.test(name) && typeof option === "string" && option.length <= 80))) ||
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
