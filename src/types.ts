import type { ModelReasoningEffort } from '@openai/codex-sdk';
export type Effort = ModelReasoningEffort;
export type ModelOption = { model: string; efforts: Effort[]; defaultEffort?: Effort };
export type Route = { model?: string; effort?: Effort };
export type Config = { models: ModelOption[]; defaultRoute: Route; routingMode: 'auto' | 'manual' };
export type TurnSummary = { prompt: string; result: string; at: string; failed?: boolean };
export type Session = { id: string; projectPath: string; threadId?: string; createdAt: string; updatedAt: string; routingMode: 'auto' | 'manual'; route: Route; turns: TurnSummary[] };
export type Notice = (message: string) => void;
