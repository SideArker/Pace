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
import { VexDiagnosticError, type VexRequest } from "./requests.js";
export { controlRequest, assessmentRequest, shapeChoices, shapeRequest, stageRequest, taskRelationRequest, type RoutingState, type VexRequest } from "./requests.js";
export { VexDiagnosticError } from "./requests.js";
import type { ModelOption, TurnSummary } from "../../shared/types.js";
import { PRICE_SNAPSHOT, modelRates } from "../routing/pricing.js";
import { routeChoices, type RoutingChoice } from "../routing/router.js";
import {
  DEFAULT_ROUTING_PROMPTS,
  type RoutingPrompts,
} from "../routing/routing-prompts.js";

const require = createRequire(import.meta.url);
export function vexServerPath(): string | undefined {
  if (process.env.VEX_SERVER_PATH && existsSync(process.env.VEX_SERVER_PATH)) {
    return process.env.VEX_SERVER_PATH;
  }
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
    if (existsSync(path)) return path;
  } catch {
    // Fallback if package.json resolution fails
  }
  try {
    const localSibling = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "Vex", "dist", "index.js");
    if (existsSync(localSibling)) return localSibling;
  } catch {
    // Local sibling not found
  }
  return undefined;
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
    if (!this.transportFactory && (!this.serverPath || !existsSync(this.serverPath)))
      throw new VexDiagnosticError("discovery", "Vex MCP server was not found");
    this.connecting = (async () => {
      const client = new Client({ name: "pace", version: "0.1.0" });
      let transport: Transport;
      try {
        transport = this.transportFactory?.() ?? new StdioClientTransport({
          command: process.execPath,
          args: [this.serverPath!, "mcp", "serve"],
          stderr: "ignore",
          env: {
            ...getDefaultEnvironment(),
            ...(process.env.OPENROUTER_API_KEY
              ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
              : {}),
            ...(process.env.TYPESAFE_API_KEY
              ? { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY }
              : {}),
            ...(process.env.JEV_API_KEY
              ? { JEV_API_KEY: process.env.JEV_API_KEY }
              : {}),
            ...(process.env.VEX_STATS_PATH
              ? { VEX_STATS_PATH: process.env.VEX_STATS_PATH }
              : {}),
            ...(process.env.JEV_STATS_PATH
              ? { JEV_STATS_PATH: process.env.JEV_STATS_PATH }
              : {}),
            ...(process.env.TYPESAFE_BASE_URL
              ? { TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL }
              : {}),
            ...(process.env.OPENROUTER_BASE_URL
              ? { OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL }
              : {}),
            ...(process.env.TYPESAFE_MODEL
              ? { TYPESAFE_MODEL: process.env.TYPESAFE_MODEL }
              : {}),
            ...(process.env.OPENROUTER_MODEL
              ? { OPENROUTER_MODEL: process.env.OPENROUTER_MODEL }
              : {}),
            ...(process.env.JEV_MODEL
              ? { JEV_MODEL: process.env.JEV_MODEL }
              : {}),
            ...(process.env.JEV_PROVIDER
              ? { JEV_PROVIDER: process.env.JEV_PROVIDER }
              : {}),
            ...(process.env.VEX_PROVIDER
              ? { VEX_PROVIDER: process.env.VEX_PROVIDER }
              : {}),
          },
        });
      } catch (error) {
        throw new VexDiagnosticError("startup", error);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        try {
          await Promise.race([
            client.connect(transport),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Vex MCP connection timed out")), 8000);
            }),
          ]);
        } catch (error) {
          const detail = String(error);
          throw new VexDiagnosticError(
            /\bspawn\s+(?:EPERM|EACCES|ENOENT)|Cannot find module/i.test(detail) ? "startup" : "connection",
            error,
          );
        }
        let tools: Awaited<ReturnType<typeof client.listTools>>;
        try {
          tools = await client.listTools(undefined, { timeout: 8000 });
        } catch (error) {
          throw new VexDiagnosticError("tool validation", error);
        }
        if (!tools.tools.some((tool) => tool.name === "vex_choose"))
          throw new VexDiagnosticError("tool validation", "Vex MCP does not offer vex_choose");
        this.client = client;
        this.transport = transport;
      } catch (error) {
        await transport.close().catch(() => {});
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
      let tokenLimit: string | undefined;
      try {
        const failure = detail?.type === "text" ? JSON.parse(detail.text) : undefined;
        status = failure?.http_status;
        // Provider bodies may echo private inputs. Expose only known limit codes.
        tokenLimit = JSON.stringify(failure?.error_detail)?.match(/\b(max_tokens_exceeded|context_length_exceeded)\b/)?.[0];
      } catch {
        /* Keep generic failure. */
      }
      throw new Error(
        typeof status === "number" && status > 0
          ? `Vex decision tool failed (HTTP ${status})${tokenLimit ? `: ${tokenLimit}; decision context exceeds the provider token limit` : ""}`
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
