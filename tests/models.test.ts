import { expect, it, vi } from "vitest";
import { parseModelPage, readAvailableModels } from "../src/integrations/models.js";
import type { AppServerConnection } from "../src/integrations/app-server-process.js";

const entry = (model: string, efforts = ["low", "high"], hidden = false) => ({
  model,
  hidden,
  supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: "" })),
  defaultReasoningEffort: "high",
});

it("uses Codex model IDs, supported efforts, and pagination without duplicate entries", async () => {
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (method === "initialize") return {};
    if (method === "model/list" && (params as { cursor: string | null }).cursor === null)
      return { data: [entry("gpt-6-sol"), entry("hidden-model", ["low"], true)], nextCursor: "page-2" };
    return { data: [entry("gpt-6-sol"), entry("gpt-5.6-sol", ["medium", "ultra"])], nextCursor: null };
  });
  const server = { request, notify: vi.fn(), kill: vi.fn(), setRequestHandler: vi.fn(), respond: vi.fn() } satisfies AppServerConnection;
  const models = await readAvailableModels(() => server);
  expect(models.map(model => model.model)).toEqual(["gpt-6-sol", "gpt-5.6-sol"]);
  expect(models[1]).toEqual({ model: "gpt-5.6-sol", efforts: ["medium", "ultra", "high"], defaultEffort: "high" });
  expect(request).toHaveBeenCalledWith("model/list", { cursor: "page-2", includeHidden: false });
  expect(server.kill).toHaveBeenCalledOnce();
});

it("rejects malformed catalog pages", () => {
  expect(() => parseModelPage({ data: [], nextCursor: 7 })).toThrow("Invalid Codex model catalog response");
  expect(() => parseModelPage({ data: [{ model: "bad model", hidden: false, supportedReasoningEfforts: [] }], nextCursor: null })).toThrow("Invalid Codex model catalog entry");
});
