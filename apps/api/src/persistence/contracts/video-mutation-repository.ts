import type { VideoDetailRow } from "./video-read-repository";
import type { VideoDeletionOptions } from '../../domain/media/video-mutation';
export { validateVideoDeletionOptions, type VideoDeletionOptions } from '../../domain/media/video-mutation';
export type VideoDeletion = { deleted: false; cleanupTaskId: null } | { deleted: true; cleanupTaskId: number | null };
export interface VideoMutationRepository {
  update(videoId: number, userId: string, fields: { title?: string; description?: string; transcript?: string }):
    Promise<{ notFound: true } | { row: VideoDetailRow; reindexTaskId: number | null }>;
  delete(videoId: number, userId: string, options?: VideoDeletionOptions): Promise<VideoDeletion>;
}
