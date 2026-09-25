import type { ModelReasoningEffort, Usage } from "@openai/codex-sdk";
export type Effort = ModelReasoningEffort;
export type ModelOption = {
  model: string;
  efforts: Effort[];
  defaultEffort?: Effort;
  enabled?: boolean;
};
export type Route = { model?: string; effort?: Effort };
export type Config = {
  models: ModelOption[];
  defaultRoute: Route;
  routingMode: "auto" | "manual";
};
export type TurnSummary = {
  prompt: string;
  result: string;
  at: string;
  route?: Route;
  artifacts?: string[];
  usage?: Usage;
  failed?: boolean;
};
export type Session = {
  id: string;
  projectPath: string;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
  routingMode: "auto" | "manual";
  route: Route;
  turns: TurnSummary[];
};
export type Notice = (message: string) => void;
