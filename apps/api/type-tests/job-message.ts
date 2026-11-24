// Compile-only producer contract; regular API typecheck must reject each invalid case.
import type { JobMessage } from '../src/application/job-message';
import { buildJobMessage } from '../src/lib/job-message';

declare function enqueue(message: JobMessage): void;
enqueue({ type: 'delete_account_data', job_id: 'job', payload: { user_id: 'owner' } });
enqueue({ type: 'transcribe_video_chunk', job_id: 'job', payload: { video_id: 1, run_id: 'run', chunk_index: 0 } });
enqueue({ type: 'build_video_visuals', job_id: 'job', payload: { video_id: 1, run_id: 'run', cache_kind: 'coarse' } });

// @ts-expect-error Account deletion cannot target a video ID.
enqueue({ type: 'delete_account_data', job_id: 'job', payload: { video_id: 1 } });
// @ts-expect-error Video transcription cannot target a user ID.
enqueue({ type: 'transcribe_video', job_id: 'job', payload: { user_id: 'owner' } });
// @ts-expect-error A chunk requires its run and index.
enqueue({ type: 'transcribe_video_chunk', job_id: 'job', payload: { video_id: 1 } });
// @ts-expect-error Only visual cache kinds are accepted.
enqueue({ type: 'build_video_visuals', job_id: 'job', payload: { video_id: 1, run_id: 'run', cache_kind: 'invalid' } });

buildJobMessage('delete_account_data', { user_id: 'owner' });
buildJobMessage('reindex_all_videos_embeddings');
// @ts-expect-error Builder must preserve the same type/payload correlation.
buildJobMessage('delete_account_data', { video_id: 1 });
// @ts-expect-error A video job cannot omit its payload.
buildJobMessage('transcribe_video');
// @ts-expect-error A chunk requires its run and index at the producer boundary.
buildJobMessage('build_video_visual_chunk', { video_id: 1 });
