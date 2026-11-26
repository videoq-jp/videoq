export const TRANSCRIPTION_LANES = 4;
export const TRANSCRIPTION_FAILURE_LIMIT = 5;
export type TranscriptionStatus = 'pending' | 'processing' | 'error';
export type TranscriptionFailure = 'TRANSCRIPTION_FAILED' | 'PROCESSING_QUOTA_EXCEEDED';
export type TranscriptSegment = { start: number; end: number; text: string };
export type TranscriptionRun = {
  videoId: number; runId: string; fileKey: string; sourceRevision: string;
  durationMs: number; chunkSeconds: number; chunkCount: number;
  completed: boolean; transcriptionLanguage: string | null;
};

export function validTranscriptionPlan(durationMs: number, chunkSeconds: number): boolean {
  const count = Math.ceil(durationMs / (chunkSeconds * 1000));
  return Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= 3_000_000_000 &&
    Number.isSafeInteger(chunkSeconds) && chunkSeconds >= 30 && chunkSeconds <= 300 && count <= 10000;
}

export function transcriptionPlan(durationMs: number, chunkSeconds: number) {
  if (!validTranscriptionPlan(durationMs, chunkSeconds)) throw new Error('Invalid transcription plan');
  return { count: Math.ceil(durationMs / (chunkSeconds * 1000)), seconds: Math.ceil(durationMs / 1000) };
}

export function validTranscriptionSegments(segments: readonly TranscriptSegment[]): boolean {
  return segments.every(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end >= s.start && typeof s.text === 'string');
}

export function validateTranscriptionBegin(status: string): void {
  if (!['pending', 'error', 'processing'].includes(status)) throw new Error('Invalid transcription state');
}

export function validateTranscriptionFinish(transcript: string | null, errorCode: string | null): void {
  if (!transcriptionFailureAllowed(transcript, errorCode)) {
    throw new Error('Invalid transcription failure');
  }
}

export function transcriptionFailureAllowed(transcript: string | null, errorCode: string | null): boolean {
  return transcript !== null || errorCode === 'TRANSCRIPTION_FAILED' || errorCode === 'PROCESSING_QUOTA_EXCEEDED';
}

/** These operations evaluate facts or compile the same policy inside a write fence. */
export interface TranscriptionLogic<Predicate> {
  and(...terms: Predicate[]): Predicate;
  or(...terms: Predicate[]): Predicate;
  not(term: Predicate): Predicate;
}

export function transcriptionSourceEligible<Predicate>(
  states: { pending: Predicate; processing: Predicate; error: Predicate }, logic: TranscriptionLogic<Predicate>,
): Predicate {
  return logic.or(states.pending, states.processing, states.error);
}

export function transcriptionRunReusable<Predicate>(
  facts: { sameFile: Predicate; sameRevision: Predicate; incomplete: Predicate }, logic: TranscriptionLogic<Predicate>,
): Predicate {
  return logic.and(facts.sameFile, facts.sameRevision, facts.incomplete);
}

export function transcriptionRunActive<Predicate>(
  facts: { belongsToVideo: Predicate; reusable: Predicate; eligibleSource: Predicate }, logic: TranscriptionLogic<Predicate>,
): Predicate {
  return logic.and(facts.belongsToVideo, facts.reusable, facts.eligibleSource);
}

export function transcriptionQuotaAllowed<Predicate>(
  facts: { alreadyReserved: Predicate; notOverQuota: Predicate; representable: Predicate; withinLimit: Predicate },
  logic: TranscriptionLogic<Predicate>,
): Predicate {
  return logic.or(facts.alreadyReserved, logic.and(facts.notOverQuota, facts.representable, facts.withinLimit));
}

export function transcriptionFinishAllowed<Predicate>(
  facts: { processing: Predicate; error: Predicate; hasRun: Predicate; completeCurrentRun: Predicate },
  logic: TranscriptionLogic<Predicate>,
): Predicate {
  return logic.and(logic.or(facts.processing, facts.error),
    logic.or(logic.not(facts.hasRun), facts.completeCurrentRun), logic.or(facts.hasRun, facts.processing));
}

/** Source-level no-audio rejection also works before a checkpoint run exists. */
export function transcriptionRejectionAllowed<Predicate>(
  hasRun: Predicate, incompleteMatchingRun: Predicate, logic: TranscriptionLogic<Predicate>,
): Predicate {
  return logic.or(logic.not(hasRun), incompleteMatchingRun);
}

export interface TranscriptionChoice<Value, Predicate> extends TranscriptionLogic<Predicate> {
  choose(condition: Predicate, yes: Value, no: Value): Value;
  literal(value: 'completed' | 'indexing' | 'error' | ''): Value;
}

export function transcriptionCompletion<Value, Predicate>(
  sameRevision: Predicate, hasTranscript: Predicate, errorCode: Value, logic: TranscriptionChoice<Value, Predicate>,
) {
  const saveTranscript = logic.and(sameRevision, hasTranscript);
  return {
    saveTranscript,
    status: logic.choose(sameRevision,
      logic.choose(hasTranscript, logic.literal('indexing'), logic.literal('error')), logic.literal('completed')),
    error: logic.choose(logic.and(sameRevision, logic.not(hasTranscript)), errorCode, logic.literal('')),
  };
}
