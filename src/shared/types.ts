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
export type ManualWorkflow = {
  shape: "single" | "scout" | "plan" | "scout_plan" | "plan_execute" | "scout_plan_execute" | "plan_verify";
  routes: Partial<Record<"scout" | "plan" | "final", Route | "vex">>;
};
export type ApprovalMode = "full-access" | "request-approval" | "limited";
export type Task = { id: string; text: string; completed: boolean; source: "user" | "agent" };
export type TurnActivity = {
  category: "thinking" | "command" | "files" | "tool" | "search" | "plan";
  text: string;
  detail?: string;
  outcome?: "success" | "failure";
  durationMs?: number;
  tokens?: number;
};
export type ContextMeasurement = {
  tokens: number;
  windowTokens: number;
  model?: string;
};
export type Config = {
  models: ModelOption[];
  defaultRoute: Route;
  routingMode: "auto" | "manual";
  approvalMode?: ApprovalMode;
  trustedFolders?: string[];
  skillFolder?: string | null;
  disabledSkills?: string[];
  autoLaunchSkills?: string[];
};
export type TurnSummary = {
  operation?: QueuedOperation;
  /** A saved file edit record, or "none" when a snapshot found no changes. */
  fileEdits?: string;
  prompt: string;
  displayPrompt?: string;
  intent?: OperationIntent;
  result: string;
  at: string;
  route?: Route;
  routeNote?: string;
  systemMessages?: string[];
  activities?: TurnActivity[];
  questions?: { question: string; answer: string }[];
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
  attemptId?: string;
  knownUsage?: Usage;
  usageComplete?: boolean;
  knownCostUsd?: number;
  at: string;
  threadId: string;
  route: Route;
  durationMs: number;
  outcome: "completed" | "failed" | "cancelled";
  usage?: Usage;
  estimatedCostUsd?: number;
  error?: string;
};
export type CheckpointNote = {
  complete: true;
  goal: string;
  constraints: string[];
  findings: { detail: string; file?: string }[];
  changes: { detail: string; file?: string }[];
  checks: { command: string; outcome: string }[];
  unfinished: string[];
  questions: string[];
  risks: string[];
};
export type CheckpointRecord = {
  createdAt: string;
  sourceTurnAt: string;
  threadId: string;
  route: Route;
  note: CheckpointNote;
  durationMs: number;
  usage?: Usage;
  estimatedCostUsd?: number;
};
export type CheckpointGeneration = {
  at: string;
  sourceTurnAt: string;
  threadId: string;
  route: Route;
  durationMs: number;
  outcome: "valid" | "invalid" | "failed" | "cancelled";
  usage?: Usage;
  estimatedCostUsd?: number;
  error?: string;
};
export type SessionKind = "normal" | "planning";
export type OperationIntent = "verify_plan" | "execute_plan" | "revise_plan" | "continue_verify" | "aside" | "adopt_side";
export type AgentRole = "main" | "scout" | "verifier" | "aside" | "status";
export type QueuedOperation = {
  id: string; text: string; intent?: OperationIntent;
  sessionId: string; taskId?: string; role: AgentRole; sourceSideId?: string;
};
export type WorkflowShape = "single" | "scout" | "plan" | "scout_plan";
export type TaskAssessment = "closed" | "partial" | "unknown";
export type WorkflowState = {
  version: 1; generation: number; shape: WorkflowShape; stage: "scout" | "plan" | "final";
  status?: StageAttempt["status"];
  mainRoute?: Route; mainThreadId?: string; scoutHandoff?: string;
  source: "vex" | "user"; needsAssessment?: boolean;
};
export type AttemptObservation = {
  kind: "activity" | "tasks" | "answer" | "artifacts";
  text?: string; items?: Pick<Task, "text" | "completed">[]; paths?: string[];
};
export type StageAttempt = {
  pricing?: import("../core/routing/pricing.js").PriceSnapshot;
  id: string; taskId: string; generation: number; stage: string; role: AgentRole;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "awaiting_user";
  route: Route; threadId?: string; turnId?: string; startedAt: string; finishedAt?: string;
  durationMs?: number; result?: string; error?: string; handoff?: string;
  usage?: Usage; knownUsage?: Usage; usageComplete?: boolean; estimatedCostUsd?: number; knownCostUsd?: number;
  observations: AttemptObservation[];
  assessment?: { value: TaskAssessment; evidence: number; decisionId: string };
};
export type ControlRecord = {
  requests?: number; failed?: boolean; error?: string;
  id: string; taskId?: string; attemptId?: string; stage?: string; role: AgentRole;
  objective: string; choice: string; confidence: number; probabilities: Record<string, number>;
  durationMs: number; at: string; source: "vex" | "user"; contextAction: "continue";
};
export type SideAnswer = {
  id: string; taskId?: string; attemptId: string; question: string; snapshotAt: string;
  result?: string; error?: string; route: Route; threadId?: string; adopted?: boolean;
};
export type RoleState = { route: Route; threadId?: string; threadTurnCount?: number; context?: ContextMeasurement; tasks?: Task[] };
export type ActiveTask = {
  originalRequest: string; instructions: string[]; latestOutcome?: string; failed?: boolean;
  id?: string; workflow?: WorkflowState; assessment?: TaskAssessment;
};
export type Session = {
  accountingIncomplete?: boolean;
  revision?: number;
  attempts?: StageAttempt[];
  controlDecisions?: ControlRecord[];
  sideAnswers?: SideAnswer[];
  verifier?: RoleState;
  executionSource?: { sessionId: string; taskId?: string; artifact?: string; plan: string; operationId?: string };
  id: string;
  kind?: SessionKind;
  plan?: string;
  planArtifact?: string;
  pendingPlanArtifact?: string;
  planRoute?: Route;
  verifierThreadId?: string;
  title?: string;
  projectPath: string;
  threadId?: string;
  threadTurnCount?: number;
  contextByThread?: Record<string, ContextMeasurement>;
  createdAt: string;
  updatedAt: string;
  routingMode: "auto" | "manual";
  route: Route;
  manualWorkflow?: ManualWorkflow;
  activeSkills?: string[];
  autoLaunchSkills?: string[];
  autoLaunchThreadId?: string;
  tasks?: Task[];
  activeTask?: ActiveTask;
  deferredTurn?: { operation?: QueuedOperation; prompt: string; retryAt: string; attempt: number; reason?: "usage" | "network" | "capacity"; intent?: OperationIntent; displayPrompt?: string };
  queuedPrompts?: (string | QueuedOperation)[];
  skillOptions?: Record<string, string>;
  turns: TurnSummary[];
  undoneTurns?: TurnSummary[];
  compactions?: CompactionRecord[];
  checkpoint?: CheckpointRecord;
  checkpointGenerations?: CheckpointGeneration[];
};
export type Notice = (message: string) => void;
