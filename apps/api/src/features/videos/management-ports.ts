import type { CreationIdempotency } from "../../persistence/contracts/creation-idempotency";
import type {
  VideoReadRepository,
  VideoDetailRow,
  VideoDetail,
} from "../../persistence/contracts/video-read-repository";
import type { VideoUploadRepository } from "../../persistence/contracts/video-upload-repository";
import type { VideoMutationRepository } from "../../persistence/contracts/video-mutation-repository";

export type YoutubeCreateRequest = {
  youtube_url: string;
  title: string;
  description: string;
};
export interface VideoManagementDependencies {
  extractYoutubeVideoId(value: string): string | null;
  list: VideoReadRepository["listPage"];
  detail: VideoReadRepository["getDetail"];
  createYoutube(
    userId: string,
    input: {
      sourceUrl: string;
      youtubeVideoId: string;
      title: string;
      description: string;
    },
    idempotency?: CreationIdempotency,
  ): ReturnType<VideoUploadRepository["createYoutube"]>;
  update: VideoMutationRepository["update"];
  delete: VideoMutationRepository["delete"];
  fileKey(
    videoId: number,
    userId: string,
  ): Promise<{ found: false } | { found: true; fileKey: string | null }>;
  ownedBy(videoId: number, userId: string): Promise<boolean>;
  mapDetail(row: VideoDetailRow): Promise<VideoDetail>;
  validateTranscript(value: string): string | null;
  requireYoutube(): void;
  storageBytes(fileKey: string | null): Promise<number | null>;
  dispatch(taskId: number): Promise<void>;
}
