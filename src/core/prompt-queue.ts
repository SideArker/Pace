/** Prompts waiting for the active turn in each conversation to finish. */
export class PromptQueue {
  private readonly prompts = new Map<string, string[]>();

  add(sessionId: string, prompt: string): number {
    const pending = this.prompts.get(sessionId) ?? [];
    pending.push(prompt);
    this.prompts.set(sessionId, pending);
    return pending.length;
  }

  take(sessionId: string): string | undefined {
    const pending = this.prompts.get(sessionId);
    const prompt = pending?.shift();
    if (!pending?.length) this.prompts.delete(sessionId);
    return prompt;
  }

  list(sessionId: string): readonly string[] {
    return this.prompts.get(sessionId) ?? [];
  }

  clear(sessionId: string): number {
    const count = this.list(sessionId).length;
    this.prompts.delete(sessionId);
    return count;
  }
}
