import type { Usage } from "@openai/codex-sdk";
import type { Route } from "../../shared/types.js";
import type { RoutingRecord, StageRecord } from "../../core/orchestrator.js";

export type Arm = "baseline" | "luna_low" | "routed_single" | "routed_split" | "routed_auto";

export type BenchmarkCase = {
  id: string;
  prompt: string;
  ref?: string;
  setup?: string[];
  checks?: string[];
  rubric?: string;
};

export type Suite = { repository: string; ref?: string; cases: BenchmarkCase[] };
export type CommandResult = { command: string; exitCode: number; output: string };

export type Run = {
  id: string;
  repetition: number;
  arm: Arm;
  commit: string;
  promptSha256: string;
  route?: Route;
  routeNote?: string;
  durationMs: number;
  usage?: Usage;
  estimatedCostUsd?: number;
  stages: StageRecord[];
  routing: RoutingRecord[];
  paceRoutingCalls: number;
  agentVexCalls: number;
  rubric?: string;
  subturns: { mode: string; route: Route; durationMs: number; usage?: Usage; estimatedCostUsd?: number; error?: string }[];
  vex?: { requests: number; inputTokens: number; outputTokens: number; cost: number };
  mcpCalls: string[];
  vexShellCommands: string[];
  checks: CommandResult[];
  result?: string;
  error?: string;
  gitStatus: string;
  diffFile: string;
};
