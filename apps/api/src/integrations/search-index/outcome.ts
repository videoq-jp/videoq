import { SafeJobError } from '../../application/job-failure';
import type { SceneIndexOutcome } from '../../application/scene-index-execution';

type FailureOutcome = Exclude<SceneIndexOutcome, { status: 'completed' | 'skipped' }>;

/** The queue boundary keeps retry behavior while exposing typed diagnostic facts. */
export class SceneIndexOutcomeError extends SafeJobError {
  constructor(readonly outcome: FailureOutcome) {
    const detail = failureDetails(outcome);
    super(detail.code, detail.retryable, detail.message);
    this.name = 'SceneIndexOutcomeError';
  }
}

function failureDetails(outcome: FailureOutcome): { message: string; code: ConstructorParameters<typeof SafeJobError>[0]; retryable: boolean } {
  switch (outcome.status) {
    case 'pending_delivery': return { message: 'Scene index delivery is awaiting search visibility; retry', code: 'INDEX_DELIVERY_PENDING', retryable: true };
    case 'source_changed': return {
      message: {
        start: 'Scene source changed before indexing; retry', stage: 'Scene source changed during indexing; retry',
        publish: 'Scene source changed before publication; retry', finish: 'Scene source changed before indexing completion; retry',
      }[outcome.phase], code: 'INDEX_SOURCE_CHANGED', retryable: true,
    };
    case 'not_ready': return { message: 'Video is not ready for indexing', code: 'INDEX_NOT_READY', retryable: true };
    case 'invalid_transcript': return {
      message: { empty: 'Video has no transcript', malformed: 'Transcript contains no valid SRT scenes', split_empty: 'Scene splitting produced no valid SRT scenes' }[outcome.reason],
      code: 'INVALID_TRANSCRIPT', retryable: false,
    };
    case 'invalid_embeddings': return { message: 'Embedding row count mismatch', code: 'INVALID_EMBEDDINGS', retryable: true };
  }
}

export function sceneIndexCount(outcome: SceneIndexOutcome): number {
  if (outcome.status === 'completed') return outcome.sceneCount;
  if (outcome.status === 'skipped') return 0;
  throw new SceneIndexOutcomeError(outcome);
}
