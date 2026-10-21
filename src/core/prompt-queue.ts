import type { QueuedOperation } from "../shared/types.js";
import { operation } from "./operations.js";
/** Durable operations waiting for the active turn in each conversation. */
export class PromptQueue {
  private readonly prompts = new Map<string, QueuedOperation[]>();
  constructor(private readonly onChange?: (sessionId: string, prompts: readonly QueuedOperation[]) => void) {}
  restore(sessionId: string, prompts: readonly (string | QueuedOperation)[]): void {
    if (prompts.length) this.prompts.set(sessionId, prompts.map(item => operation(item, sessionId)));
    else this.prompts.delete(sessionId);
  }
  private changed(sessionId: string) { this.onChange?.(sessionId, [...this.operations(sessionId)]); }
  operations(sessionId: string): readonly QueuedOperation[] { return this.prompts.get(sessionId) ?? []; }
  peekOperation(sessionId: string): QueuedOperation | undefined { return this.operations(sessionId)[0]; }
  acknowledge(sessionId: string, operationId: string): void {
    const index = this.operations(sessionId).findIndex(item => item.id === operationId);
    if (index >= 0) this.remove(sessionId, index);
  }
  list(sessionId: string): readonly string[] { return this.operations(sessionId).map(item => item.text); }
  add(sessionId: string, prompt: string | QueuedOperation): number {
    const pending = this.prompts.get(sessionId) ?? [];
    pending.push(operation(prompt, sessionId)); this.prompts.set(sessionId, pending); this.changed(sessionId); return pending.length;
  }
  takeOperation(sessionId: string): QueuedOperation | undefined {
    const pending = this.prompts.get(sessionId); const item = pending?.shift();
    if (!pending?.length) this.prompts.delete(sessionId);
    if (item) this.changed(sessionId); return item;
  }
  take(sessionId: string): string | undefined { return this.takeOperation(sessionId)?.text; }
  get(sessionId: string, index: number) { return this.prompts.get(sessionId)?.[index]?.text; }
  set(sessionId: string, index: number, text: string): boolean {
    const item = this.prompts.get(sessionId)?.[index]; if (!item) return false;
    item.text = text; this.changed(sessionId); return true;
  }
  remove(sessionId: string, index: number): string | undefined {
    const pending = this.prompts.get(sessionId); if (!pending || index < 0 || index >= pending.length) return undefined;
    const [item] = pending.splice(index, 1); if (!pending.length) this.prompts.delete(sessionId);
    this.changed(sessionId); return item?.text;
  }
  pop(sessionId: string): string | undefined { return this.remove(sessionId, this.operations(sessionId).length - 1); }
  clear(sessionId: string): number { const count = this.list(sessionId).length; this.prompts.delete(sessionId); if (count) this.changed(sessionId); return count; }
}
