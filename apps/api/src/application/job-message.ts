/** Workerへ渡すジョブメッセージ。DB outboxにも同じ形で保存する。 */
export const JOB_TRANSCRIBE_VIDEO = "transcribe_video" as const;
export const JOB_REINDEX_VIDEO_TRANSCRIPT = "reindex_video_transcript" as const;
export const JOB_DELETE_ACCOUNT_DATA = "delete_account_data" as const;
export const JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS =
  "reindex_all_videos_embeddings" as const;

type VideoPayload = { video_id: number };
type RunPayload = VideoPayload & { run_id: string };
type ChunkPayload = RunPayload & { chunk_index: number };

/** Producer contracts. Persisted JSON still requires validation at consumption. */
export interface JobPayloadMap {
  transcribe_video: VideoPayload;
  transcribe_video_chunk: ChunkPayload;
  finish_video_transcription: RunPayload;
  prepare_video_visuals: VideoPayload;
  build_video_visuals: RunPayload & { cache_kind: 'coarse' | 'focus' };
  build_video_visual_chunk: ChunkPayload;
  finish_video_visuals: RunPayload;
  index_video_transcript: VideoPayload & { allow_empty?: boolean };
  reindex_video_transcript: VideoPayload;
  delete_account_data: { user_id: string };
  reindex_all_videos_embeddings: { after_id?: number; root_job_id?: string };
}
export type JobType = keyof JobPayloadMap;
export type JobMessage = {
  [Type in JobType]: { type: Type; job_id: string; payload: JobPayloadMap[Type] }
}[JobType];

/** Tuples retain type/payload correlation even when the caller has a union. */
export type JobMessageArguments = {
  [Type in JobType]: Type extends 'reindex_all_videos_embeddings'
    ? [type: Type, payload?: JobPayloadMap[Type], jobId?: string]
    : [type: Type, payload: JobPayloadMap[Type], jobId?: string]
}[JobType];
