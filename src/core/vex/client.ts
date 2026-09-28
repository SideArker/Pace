import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ModelOption, TurnSummary } from "../../shared/types.js";
import { PRICE_SNAPSHOT, modelRates } from "../routing/pricing.js";
import { routeChoices, type RoutingChoice } from "../routing/router.js";
import {
  DEFAULT_ROUTING_PROMPTS,
  type RoutingPrompts,
} from "../routing/routing-prompts.js";

const require = createRequire(import.meta.url);
export function vexServerPath(): string | undefined {
  try {
    const resolved = fileURLToPath(import.meta.resolve("@sidearker/vex-mcp"));
    if (existsSync(resolved)) return resolved;
  } catch {
    // Fallback if import.meta.resolve is not supported or fails
  }
  try {
    const path = join(
      dirname(require.resolve("@sidearker/vex-mcp/package.json")),
      "dist",
      "index.js",
    );
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export type VexRequest = {
  question: string;
  context: Record<string, unknown>;
  options: RoutingChoice[];
  constraints: string;
  decisionType: "routing";
};
function taskContext(
  prompt: string,
  turns: TurnSummary[],
  models: ModelOption[],
  prompts: RoutingPrompts,
) {
  return {
    originalRequest: prompt,
    recentConversation: turns
      .slice(-6)
      .map((turn) => ({ user: turn.prompt, assistant: turn.result })),
    availableModels: models.map((model) => ({
      id: model.model,
      capability:
        prompts.modelCapabilities[model.model] ??
        prompts.unknownModelCapability,
      supportedEfforts: model.efforts.map((effort) => ({
        id: effort,
        capability:
          prompts.effortCapabilities[effort] ?? prompts.unknownEffortCapability,
      })),
      standardUsdPerMillionTokens: modelRates(model.model),
    })),
    priceSnapshot: {
      checkedAt: PRICE_SNAPSHOT.checkedAt,
      source: PRICE_SNAPSHOT.source,
      processing: PRICE_SNAPSHOT.processing,
      context: PRICE_SNAPSHOT.context,
    },
  };
}
export const shapeChoices: RoutingChoice[] = Object.entries(
  DEFAULT_ROUTING_PROMPTS.workflow.choices,
).map(([id, description]) => ({ id, description }));
export function shapeRequest(
  prompt: string,
  turns: TurnSummary[],
  models: ModelOption[],
  prompts = DEFAULT_ROUTING_PROMPTS,
): VexRequest {
  const configuredChoices = Object.entries(prompts.workflow.choices).map(
    ([id, description]) => ({ id, description }),
  );
  const options = models.some((model) => model.model === "gpt-6-luna")
    ? configuredChoices
    : configuredChoices.filter((choice) => choice.id !== "scout");
  return {
    question: prompts.workflow.question,
    context: taskContext(prompt, turns, models, prompts),
    options,
    decisionType: "routing",
    constraints: `${prompts.workflow.constraints}\n\nPace routing rule: when the user names a concrete command and target, treat it as actionable and choose single rather than clarify.`,
  };
}
export function stageRequest(
  prompt: string,
  turns: TurnSummary[],
  models: ModelOption[],
  objective: string,
  handoff?: string,
  availableModels = models,
  prompts = DEFAULT_ROUTING_PROMPTS,
): VexRequest {
  const options = routeChoices(models);
  return {
    question: prompts.stage.question,
    context: {
      ...taskContext(prompt, turns, availableModels, prompts),
      stageObjective: objective,
      ...(handoff ? { priorStageHandoff: handoff } : {}),
    },
    options,
    decisionType: "routing",
    constraints: prompts.stage.constraints,
  };
}

export class VexRouter {
  private client?: Client;
  private connecting?: Promise<void>;
  private transport?: Transport;
  constructor(
    readonly serverPath = vexServerPath(),
    private readonly transportFactory?: () => Transport,
  ) {}
  async start(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (!this.serverPath && !this.transportFactory)
      throw new Error("Vex MCP server was not found");
    this.connecting = (async () => {
      const client = new Client({ name: "pace", version: "0.1.0" });
      const transport =
        this.transportFactory?.() ??
        new StdioClientTransport({
          command: process.execPath,
          args: [this.serverPath!, "mcp", "serve"],
          stderr: "ignore",
          env: {
            ...getDefaultEnvironment(),
            ...(process.env.OPENROUTER_API_KEY
              ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
              : {}),
            ...(process.env.VEX_STATS_PATH
              ? { VEX_STATS_PATH: process.env.VEX_STATS_PATH }
              : {}),
          },
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Vex MCP connection timed out")),
              8000,
            );
          }),
        ]);
        const tools = await client.listTools(undefined, { timeout: 8000 });
        if (!tools.tools.some((tool) => tool.name === "vex_choose"))
          throw new Error("Vex MCP does not offer vex_choose");
        this.client = client;
        this.transport = transport;
      } catch (error) {
        await transport.close();
        this.connecting = undefined;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.connecting;
  }
  async choose(request: VexRequest): Promise<unknown> {
    await this.start();
    const result = await this.client!.callTool(
      { name: "vex_choose", arguments: request },
      undefined,
      // Vex allows its provider request 45 seconds; leave time for its MCP response.
      { timeout: 60000 },
    );
    if (result.isError) {
      const detail = Array.isArray(result.content)
        ? result.content.find((item) => item.type === "text")
        : undefined;
      let status: unknown;
      try {
        status =
          detail?.type === "text"
            ? JSON.parse(detail.text).http_status
            : undefined;
      } catch {
        /* Keep generic failure. */
      }
      throw new Error(
        typeof status === "number" && status > 0
          ? `Vex decision tool failed (HTTP ${status})`
          : "Vex decision tool failed; check Vex credentials and network access",
      );
    }
    return result.structuredContent;
  }
  async verify(): Promise<void> {
    await this.start();
    await this.client!.ping({ timeout: 5000 });
  }
  get connected(): boolean {
    return this.client !== undefined;
  }
  async close(): Promise<void> {
    await this.connecting?.catch(() => {});
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
  }
}
