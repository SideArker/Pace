/** Prompts waiting for the active turn in each conversation to finish. */
export class PromptQueue {
  private readonly prompts = new Map<string, string[]>();
  constructor(private readonly onChange?: (sessionId: string, prompts: readonly string[]) => void) {}

  restore(sessionId: string, prompts: readonly string[]): void {
    if (prompts.length) this.prompts.set(sessionId, [...prompts]);
    else this.prompts.delete(sessionId);
  }

  private changed(sessionId: string): void {
    this.onChange?.(sessionId, [...this.list(sessionId)]);
  }

  add(sessionId: string, prompt: string): number {
    const pending = this.prompts.get(sessionId) ?? [];
    pending.push(prompt);
    this.prompts.set(sessionId, pending);
    this.changed(sessionId);
    return pending.length;
  }

  take(sessionId: string): string | undefined {
    const pending = this.prompts.get(sessionId);
    const prompt = pending?.shift();
    if (!pending?.length) this.prompts.delete(sessionId);
    if (prompt !== undefined) this.changed(sessionId);
    return prompt;
  }

  list(sessionId: string): readonly string[] {
    return this.prompts.get(sessionId) ?? [];
  }

  get(sessionId: string, index: number): string | undefined {
    return this.prompts.get(sessionId)?.[index];
  }

  set(sessionId: string, index: number, prompt: string): boolean {
    const pending = this.prompts.get(sessionId);
    if (!pending || index < 0 || index >= pending.length) return false;
    pending[index] = prompt;
    this.changed(sessionId);
    return true;
  }

  remove(sessionId: string, index: number): string | undefined {
    const pending = this.prompts.get(sessionId);
    if (!pending || index < 0 || index >= pending.length) return undefined;
    const [removed] = pending.splice(index, 1);
    if (!pending.length) this.prompts.delete(sessionId);
    this.changed(sessionId);
    return removed;
  }

  pop(sessionId: string): string | undefined {
    const pending = this.prompts.get(sessionId);
    if (!pending || !pending.length) return undefined;
    const removed = pending.pop();
    if (!pending.length) this.prompts.delete(sessionId);
    this.changed(sessionId);
    return removed;
  }

  clear(sessionId: string): number {
    const count = this.list(sessionId).length;
    this.prompts.delete(sessionId);
    if (count) this.changed(sessionId);
    return count;
  }
}
