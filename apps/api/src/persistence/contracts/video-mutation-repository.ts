import type { VideoDetailRow } from "./video-read-repository";
export type VideoDeletionOptions = {
  expectedStatus?: string;
  expectedFileKey?: string;
  fallbackStorageBytes?: number | null;
  inactiveBefore?: Date;
};
export type VideoDeletion = { deleted: false; cleanupTaskId: null } | { deleted: true; cleanupTaskId: number | null };
export interface VideoMutationRepository {
  update(videoId: number, userId: string, fields: { title?: string; description?: string; transcript?: string }):
    Promise<{ notFound: true } | { row: VideoDetailRow; reindexTaskId: number | null }>;
  delete(videoId: number, userId: string, options?: VideoDeletionOptions): Promise<VideoDeletion>;
}
export function validateVideoDeletionOptions(options: VideoDeletionOptions): void {
  if (options.fallbackStorageBytes != null && (!Number.isSafeInteger(options.fallbackStorageBytes) || options.fallbackStorageBytes < 0) ||
      options.inactiveBefore && !Number.isFinite(options.inactiveBefore.getTime())) throw new Error("Invalid video deletion options");
}
