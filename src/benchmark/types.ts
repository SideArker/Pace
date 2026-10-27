export type Category = 'fresh-completion';
export type Profile = {
  category: Category; name: string; version: 1; label: string; driver: string;
  suite?: string; args: string[]; variants: string[]; repeats: number;
  evaluation: string; route: string; paid: boolean; timeoutMinutes: number; maxUsd: number;
};
export type Selection = { category: string; profile: string; baseline?: string; source?: string; dataset?: string; offline?: boolean; controlled?: boolean; maxUsd?: number; maxTurns?: number };
export type Trial = { key: string; description: string };
export type Preview = { selection: Selection; profile: Profile; suiteHash?: string; plan: Trial[]; maximumModelTurns: number; estimate: string; baselineScope?: string; resolvedCommits: Record<string, string>; dependencies: string[]; effectiveConfig?: unknown; datasetHash?: string; datasetManifest?: unknown };
export type Event = { at: string; kind: string; [key: string]: unknown };
export type RunManifest = { schemaVersion: 1; id: string; createdAt: string; preview: Preview; sourceSha256: string; sourceHashes: Record<string,string>; commit: string; dirty: boolean; priceSnapshot: unknown; controlled: false };
export type RunState = { version: 1; execution: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; quality: 'needs-review' | 'diagnostic' | 'passed' | 'failed'; segment: number; error?: string; updatedAt: string };
