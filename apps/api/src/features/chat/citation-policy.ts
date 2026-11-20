import { protectedTextRanges, type ModelAnswer, type ChatSource, type ChatAnswer } from '@videoq/domain/chat';

export type RejectedCitations = { invalid_id: number; unknown_id: number; duplicate_id: number; unsafe_position: number };
export interface CitationValidationDependencies {
  validateSource(source: ChatSource): void;
  onRejected(counts: RejectedCitations): void;
}

/** Only authorized source identities and safe prose boundaries may receive links. */
export function validateAnswerCitations(answer: ModelAnswer, sources: readonly ChatSource[], deps: CitationValidationDependencies): ChatAnswer {
  if (!answer.segments.some(segment => segment.text.trim())) throw new Error("Empty structured answer");
  const registry = new Set(sources.map(source => {
    deps.validateSource(source);
    return source.id;
  }));
  if (registry.size !== sources.length) throw new Error("Duplicate source ID");
  const rejected = { invalid_id: 0, unknown_id: 0, duplicate_id: 0, unsafe_position: 0 };
  const ranges = protectedTextRanges(answer.segments.map(s => s.text).join(""));
  let offset = 0;
  const segments = answer.segments.map(segment => {
    offset += segment.text.length;
    const safe = !ranges.some(range => range.start < offset && offset < range.end);
    const seen = new Set<number>();
    const sourceIds = segment.sourceIds.filter(id => {
      if (!Number.isSafeInteger(id) || id <= 0) { rejected.invalid_id++; return false; }
      if (!registry.has(id)) { rejected.unknown_id++; return false; }
      if (seen.has(id)) { rejected.duplicate_id++; return false; }
      seen.add(id);
      if (!safe) { rejected.unsafe_position++; return false; }
      return true;
    });
    return { text: segment.text, sourceIds };
  });
  if (Object.values(rejected).some(Boolean)) {
    // Counts only: never log prose, IDs, transcripts or private source metadata.
    deps.onRejected(rejected);
  }
  return { segments, sources: sources.map(source => ({ ...source })) };
}
