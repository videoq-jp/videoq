import type { TranscriptionCheckpoints } from '../../persistence/contracts/transcription-checkpoints';
import type { WorkerTranscriptionRepository } from '../../persistence/contracts/worker-transcription';

/** Decide whether this run can finish; the repository fences the actual write
 * against the current source and run identity inside its atomic operation. */
export async function finishTranscriptionRun(
  checkpoints: Pick<TranscriptionCheckpoints, 'load'>,
  transcription: Pick<WorkerTranscriptionRepository, 'readSource' | 'finish'>,
  videoId: number, runId: string, transcript: string | null,
) {
  const run = await checkpoints.load(videoId, runId);
  const source = await transcription.readSource(videoId);
  if (!run || !source) return { completed: false, stale: true, status: null };
  if (run.completed) return { completed: true, stale: false, status: source.status };
  if (run.fileKey !== source.fileKey || run.sourceRevision !== source.sourceRevision) return { completed: false, stale: true, status: source.status };
  const status = await transcription.finish(source, transcript, transcript === null ? 'TRANSCRIPTION_FAILED' : null, runId);
  return { completed: Boolean((await checkpoints.load(videoId, runId))?.completed), stale: false, status };
}
