/** Canonical wire contract. Mirror to Pace/src/remote/protocol.ts with scripts/sync-protocol.mjs. */
import { z } from 'zod';

export const VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;
export const id = z.uuid();
const text = z.string().min(1).max(32000);
const target = { projectId: z.string().regex(/^[a-f0-9]{64}$/), sessionId: id };
export const routeSchema = z.object({ model: z.string().min(1).max(120).optional(), effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'persistent']).optional() }).strict();
export const approvalModeSchema = z.enum(['full-access', 'request-approval', 'limited']);
const methods = {
  'projects.list': z.object({}).strict(),
  'sessions.list': z.object({ projectId: target.projectId }).strict(),
  'sessions.create': z.object({ projectId: target.projectId, kind: z.enum(['normal', 'planning']).default('normal') }).strict(),
  'sessions.snapshot': z.object({ ...target }).strict(),
  'prompts.send': z.object({ ...target, prompt: text, key: id }).strict(),
  'queue.remove': z.object({ ...target, index: z.number().int().min(0).max(99) }).strict(),
  'turn.cancel': z.object({ ...target }).strict(),
  'interaction.answer': z.object({ ...target, interactionId: id, decision: z.enum(['accept', 'decline']).optional(), answers: z.record(z.string().max(200), z.object({ answers: z.array(z.string().max(32000)).max(20) }).strict()).optional() }).strict(),
  'routing.set': z.object({ ...target, mode: z.enum(['auto', 'manual']), route: routeSchema }).strict(),
  'approval.set': z.object({ mode: approvalModeSchema }).strict(),
  'models.list': z.object({}).strict(),
  'usage.get': z.object({}).strict(),
  'skills.list': z.object({}).strict(),
  'plan.run': z.object({ ...target, action: z.enum(['verify', 'execute']), key: id }).strict(),
  'task.run': z.object({ ...target, taskId: z.string().max(200), key: id }).strict(),
  'artifacts.list': z.object({ ...target }).strict(),
  'reader.read': z.object({ ...target, path: z.string().min(1).max(1024), offset: z.number().int().min(0).default(0) }).strict(),
  'diff.list': z.object({ ...target, editId: id }).strict(),
  'diff.read': z.object({ ...target, editId: id, path: z.string().min(1).max(1024), offset: z.number().int().min(0).default(0) }).strict(),
  'diff.change': z.object({ ...target, editId: id, path: z.string().min(1).max(1024), direction: z.enum(['undo', 'redo']) }).strict(),
  'devices.list': z.object({}).strict(),
  'devices.revoke': z.object({ deviceId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
} as const;
export type Method = keyof typeof methods;
export type Params<M extends Method> = z.input<(typeof methods)[M]>;
export type Request = { [M in Method]: { v: 1; id: string; method: M; params: z.output<(typeof methods)[M]> } }[Method];
const envelope = z.object({ v: z.literal(VERSION), id, method: z.enum(Object.keys(methods) as [Method, ...Method[]]), params: z.unknown() }).strict();
export function parseRequest(input: unknown): Request {
  const request = envelope.parse(input);
  return { ...request, params: methods[request.method].parse(request.params) } as Request;
}
export const pairingSchema = z.object({ v: z.literal(VERSION), address: z.url().max(512), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), token: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive() }).strict();
export type Pairing = z.infer<typeof pairingSchema>;
export type RemoteError = { code: 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'CONFLICT' | 'NOT_FOUND' | 'LIMIT' | 'INTERNAL'; message: string };
export type Response = { v: 1; id: string; ok: true; data: unknown } | { v: 1; id: string; ok: false; error: RemoteError };
export type RemoteEvent = { v: 1; type: 'changed'; cursor: string; projectId: string; sessionId: string };
export type Route = z.infer<typeof routeSchema>;
export type PendingInteraction = {
  id: string; kind: 'approval' | 'question'; command?: string; cwd?: string; reason?: string; network?: boolean;
  questions?: { id: string; header: string; question: string; options: { label: string; description: string }[]; isOther: boolean; isSecret: boolean }[];
};
export type Turn = { prompt: string; displayPrompt?: string; result: string; at: string; fileEdits?: string; artifacts?: string[]; failed?: boolean; cancelled?: boolean; route?: Route; durationMs?: number; usage?: Record<string, number> };
export type Session = {
  id: string; title?: string; kind?: 'normal' | 'planning'; plan?: string; planArtifact?: string;
  projectPath: string; routingMode: 'auto' | 'manual'; route: Route; updatedAt: string;
  turns: Turn[]; queuedPrompts?: string[]; tasks?: { id: string; text: string; completed: boolean; source: string }[];
  contextByThread?: Record<string, { tokens: number; windowTokens: number; model?: string }>; threadId?: string;
};
export type Snapshot = { cursor: string; session: Session; active?: { prompt: string; status: string; activities: string[] }; interactions: PendingInteraction[]; approvalMode: z.infer<typeof approvalModeSchema> };
export type Project = { id: string; path: string; exists: boolean };
export type FileChange = { path: string; undone: boolean };
export type TextPage = { path: string; text: string; offset: number; nextOffset: number | null; totalLines: number };
