import type { ModelReasoningEffort, Usage } from "@openai/codex-sdk";
import type { StageRecord, RoutingRecord } from '../core/orchestrator.js';
export type Effort = ModelReasoningEffort;
export type ModelOption = {
  model: string;
  efforts: Effort[];
  defaultEffort?: Effort;
  enabled?: boolean;
};
export type Route = { model?: string; effort?: Effort };
export type ContextMeasurement = {
  tokens: number;
  windowTokens: number;
  model?: string;
};
export type Config = {
  models: ModelOption[];
  defaultRoute: Route;
  routingMode: "auto" | "manual";
  trustedFolders?: string[];
  skillFolder?: string | null;
  disabledSkills?: string[];
};
export type TurnSummary = {
  prompt: string;
  result: string;
  at: string;
  route?: Route;
  routeNote?: string;
  systemMessages?: string[];
  durationMs?: number;
  artifacts?: string[];
  usage?: Usage;
  stages?: StageRecord[];
  routing?: RoutingRecord[];
  estimatedCostUsd?: number;
  failed?: boolean;
  cancelled?: boolean;
};
export type CompactionRecord = {
  at: string;
  threadId: string;
  route: Route;
  durationMs: number;
  outcome: "completed" | "failed" | "cancelled";
  usage?: Usage;
  estimatedCostUsd?: number;
  error?: string;
};
export type Session = {
  id: string;
  title?: string;
  projectPath: string;
  threadId?: string;
  contextByThread?: Record<string, ContextMeasurement>;
  createdAt: string;
  updatedAt: string;
  routingMode: "auto" | "manual";
  route: Route;
  activeSkills?: string[];
  skillOptions?: Record<string, string>;
  turns: TurnSummary[];
  compactions?: CompactionRecord[];
};
export type Notice = (message: string) => void;
