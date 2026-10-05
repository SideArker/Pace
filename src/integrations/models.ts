import { EFFORTS, isRecord } from "../shared/config.js";
import type { Effort } from "../shared/types.js";
import { AppServer, type AppServerConnection } from "./app-server-process.js";

export type AvailableModel = {
  model: string;
  efforts: Effort[];
  defaultEffort: Effort;
};

export function parseModelPage(value: unknown): { models: AvailableModel[]; nextCursor: string | null } {
  if (!isRecord(value) || !Array.isArray(value.data) ||
      !(value.nextCursor === null || typeof value.nextCursor === "string"))
    throw new Error("Invalid Codex model catalog response");
  const models: AvailableModel[] = [];
  for (const entry of value.data) {
    if (!isRecord(entry) || typeof entry.model !== "string" ||
        !/^[a-zA-Z0-9._-]+$/.test(entry.model) ||
        typeof entry.hidden !== "boolean" ||
        !Array.isArray(entry.supportedReasoningEfforts))
      throw new Error("Invalid Codex model catalog entry");
    if (entry.hidden) continue;
    const efforts = [...new Set(entry.supportedReasoningEfforts.flatMap((option: unknown) => {
      if (!isRecord(option) || !EFFORTS.includes(option.reasoningEffort as Effort)) return [];
      return [option.reasoningEffort as Effort];
    }))];
    const defaultEffort = EFFORTS.includes(entry.defaultReasoningEffort as Effort)
      ? entry.defaultReasoningEffort as Effort
      : efforts[0];
    if (!defaultEffort) continue;
    if (!efforts.includes(defaultEffort)) efforts.push(defaultEffort);
    models.push({ model: entry.model, efforts, defaultEffort });
  }
  return { models, nextCursor: value.nextCursor };
}

export async function readAvailableModels(
  createServer: () => AppServerConnection = () => new AppServer(() => {}, () => {}),
): Promise<AvailableModel[]> {
  const server = createServer();
  const timeout = setTimeout(() => server.kill(), 10_000);
  try {
    await server.request("initialize", {
      clientInfo: { name: "pace", title: "Pace", version: "0.1.0" },
      capabilities: null,
    });
    server.notify("initialized", {});
    const models = new Map<string, AvailableModel>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = parseModelPage(await server.request("model/list", { cursor, includeHidden: false }));
      for (const model of page.models) models.set(model.model, model);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Codex model catalog repeated a page cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models.values()];
  } finally {
    clearTimeout(timeout);
    server.kill();
  }
}
