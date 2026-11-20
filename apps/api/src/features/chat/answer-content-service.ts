import { protectedTextRanges, type ChatAnswer, type ChatContentPart, type ChatSource, type ModelAnswer } from '@videoq/domain/chat';
import { StructuredAnswerError } from '../../application/answer-generation';

export interface AnswerTextParser {
  push(delta: string): Array<{ segmentIndex: number; text: string }>;
  completedSegments(): ModelAnswer['segments'];
  text(): string;
  finish(): ModelAnswer;
}

/** Text is provisional; citations need a closed segment and a stable syntax boundary. */
export class AnswerContentService {
  constructor(private readonly parser: AnswerTextParser) {}
  private readonly citations = new Map<number, number[]>();
  private readonly pendingText = new Map<number, string>();
  private segmentIndex = 0;
  private offset = 0;
  private pending: ChatContentPart[] = [];
  private started = false;

  push(delta: string, sources: readonly ChatSource[]): ChatContentPart[] {
    for (const part of this.parser.push(delta)) {
      this.pendingText.set(part.segmentIndex, (this.pendingText.get(part.segmentIndex) ?? "") + part.text);
    }
    const text = this.parser.text();
    // A future character can extend a delimiter run, invalidate a closing fence,
    // or turn a trailing $ / backslash into an opening delimiter. Wait for that
    // suffix's lookahead, without delaying ordinary prose or the rest of the text.
    const stableEnd = text.length - (/[\\$`~ \t\r]*$/.exec(text)?.[0].length ?? 0);
    const parts = this.drain(this.parser.completedSegments(), sources, stableEnd);
    if (this.started) return parts;
    // Don't spend the user's quota on an empty/whitespace-only failed answer.
    // Keep its exact whitespace and segment indices once real text arrives.
    this.pending.push(...parts);
    if (!text.trim()) return [];
    this.started = true;
    return this.pending.splice(0);
  }

  finish(answer: ChatAnswer): ChatContentPart[] {
    const parsed = this.parser.finish();
    if (parsed.segments.length !== answer.segments.length
      || parsed.segments.some((segment, index) => segment.text !== answer.segments[index].text)) {
      throw new StructuredAnswerError("Structured answer differed from the streamed text.");
    }
    const parts = this.drain(answer.segments, answer.sources, Infinity);
    // Check equality in both directions: an overwritten JSON property must not
    // silently add/drop text or citations in history after a segment was sent.
    if (this.segmentIndex !== answer.segments.length || this.pendingText.size) {
      throw new StructuredAnswerError("Structured answer differed from the streamed segments.");
    }
    answer.segments.forEach((segment, segmentIndex) => {
      const emitted = this.citations.get(segmentIndex) ?? [];
      if (emitted.length !== segment.sourceIds.length
        || emitted.some((id, index) => id !== segment.sourceIds[index])) {
        throw new StructuredAnswerError("Structured answer changed a streamed citation.");
      }
    });
    return parts;
  }

  private drain(completed: ModelAnswer["segments"], sources: readonly ChatSource[], stableEnd: number): ChatContentPart[] {
    const parts: ChatContentPart[] = [];
    const ranges = protectedTextRanges(this.parser.text());
    const registry = new Set(sources.map(source => source.id));
    for (;;) {
      const index = this.segmentIndex;
      const text = this.pendingText.get(index);
      if (text !== undefined) {
        parts.push({ type: "text", segmentIndex: index, text });
        this.pendingText.delete(index);
      }
      const segment = completed[index];
      if (!segment) break;
      const offset = this.offset + segment.text.length;
      const ids = [...new Set(segment.sourceIds)].filter(id => Number.isSafeInteger(id) && id > 0 && registry.has(id));
      // Preserve the existing SSE order: text, citations, then the next segment.
      // Only ambiguous delimiter lookahead holds the next segment's text briefly.
      if (ids.length && offset > stableEnd) break;
      if (!ranges.some(range => range.start < offset && offset < range.end)) {
        for (const id of ids) this.appendCitation(parts, index, id);
      }
      this.offset = offset;
      this.segmentIndex++;
    }
    return parts;
  }

  private appendCitation(parts: ChatContentPart[], segmentIndex: number, sourceId: number): void {
    const emitted = this.citations.get(segmentIndex) ?? [];
    if (emitted.includes(sourceId)) return;
    emitted.push(sourceId);
    this.citations.set(segmentIndex, emitted);
    parts.push({ type: "citation", segmentIndex, sourceId });
  }
}
