import type { CreationIdempotency } from "./creation-idempotency";

export type OutboxedVideoJob = {
  videoId: number;
  taskId: number;
  jobId: string;
};

export type PendingVideoReservation =
  | { ok: true; videoId: number; fileKey: string; reused: boolean }
  | { idempotencyConflict: true }
  | { monthlyUploadExceeded: true; limit: number }
  | { overQuota: true }
  | { exceeded: true; limit: number };

export type YoutubeVideoCreation =
 | (Omit<OutboxedVideoJob, "taskId"> & { taskId: number | null; reused: boolean })
 | { idempotencyConflict: true };

export type VideoUploadState = { found: false } | { found: true; status: string; fileKey: string | null };
export interface VideoUploadRepository {
 reserveUpload(params: {
   userId: string; storageBytes: number; fileKey: string; title: string; description: string;
   idempotency?: CreationIdempotency; transcriptionLanguage?: string;
 }): Promise<PendingVideoReservation>;
 createYoutube(params: {
   userId: string; sourceUrl: string; youtubeVideoId: string; title: string; description: string;
   idempotency?: CreationIdempotency;
 }): Promise<YoutubeVideoCreation>;
 confirmUpload(params: { videoId: number; userId: string; fileKey: string }): Promise<false | OutboxedVideoJob>;
 getUploadState(videoId: number, userId: string): Promise<VideoUploadState>;
}
