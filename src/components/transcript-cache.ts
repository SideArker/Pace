import type { Line } from "./Transcript.js";

/** Keep recent completed transcripts while protecting the selected and running ones. */
export class TranscriptLineCache {
  private readonly entries = new Map<string, Line[]>();

  constructor(private readonly maxEntries = 4) {}

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  get(sessionId: string): Line[] | undefined {
    const lines = this.entries.get(sessionId);
    if (lines) {
      this.entries.delete(sessionId);
      this.entries.set(sessionId, lines);
    }
    return lines;
  }

  set(sessionId: string, lines: Line[], activeId?: string, runningIds: Iterable<string> = []): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, lines);
    this.retain(activeId, runningIds, sessionId);
  }

  retain(activeId?: string, runningIds: Iterable<string> = [], writingId?: string): void {
    const protectedIds = new Set(runningIds);
    if (activeId) protectedIds.add(activeId);
    if (writingId) protectedIds.add(writingId);
    for (const sessionId of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      if (!protectedIds.has(sessionId)) this.entries.delete(sessionId);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
