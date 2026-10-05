export type RoutingCase = {
  id: string;
  category: string;
  prompt: string;
  preferred: "single" | "scout" | "plan_execute" | "scout_plan_execute" | "clarify";
  acceptable: string[];
  reason: string;
  conversation?: { user: string; assistant: string }[];
  handoff?: {
    summary: string;
    findings: {
      path: string;
      line?: number;
      finding: string;
      relevance: string;
    }[];
    nextSteps: string[];
    checks: string[];
    risks: string[];
  };
};
export type RoutingSuite = { version: 1; cases: RoutingCase[] };
type DecisionLog = {
  objective: string;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  attempts: number;
  elapsedMs: number;
  route?: { model?: string; effort?: string };
};
export type RoutingRun = {
  id: string;
  category: string;
  repetition: number;
  promptSha256: string;
  preferred: string;
  acceptable: string[];
  shape?: string;
  acceptableHit?: boolean;
  preferredHit?: boolean;
  decisions: DecisionLog[];
  vexCalls: number;
  retries: number;
  elapsedMs: number;
  error?: string;
};
