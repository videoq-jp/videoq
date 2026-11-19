import { videoUploadService } from "../../integrations/video-upload";
import { videoManagementService } from "../../integrations/video-management";
import type { UploadRequest } from "./upload-service";
import type { YoutubeCreateRequest } from "./management-ports";
import type { Bindings } from "../../types/bindings";
import type { CreationIdempotency } from "../../persistence/contracts/creation-idempotency";

export {
  getMultipartUploadPartUrl,
  UploadSessionError,
} from "../../repositories/multipart-upload-repository";

export {
  countVideosByStatus as getUserVideoStats,
  getVideoDetail as getUserVideo,
} from "../../repositories/video-repository";

export function listUserVideos(
  env: Bindings,
  userId: string,
  query: {
    q?: string;
    status?: string;
    ordering?: string;
    tags?: number[];
  },
  limit: number,
  offset: number,
) {
  return videoManagementService(env).listUserVideos(
    userId,
    query,
    limit,
    offset,
  );
}
export function createUserYoutubeVideo(
  env: Bindings,
  userId: string,
  body: YoutubeCreateRequest,
  idempotency?: CreationIdempotency,
) {
  return videoManagementService(env).createUserYoutubeVideo(
    userId,
    body,
    idempotency,
  );
}
export function patchUserVideo(
  env: Bindings,
  videoId: number,
  userId: string,
  fields: { title?: string; description?: string; transcript?: string },
) {
  return videoManagementService(env).patchUserVideo(videoId, userId, fields);
}
export function deleteUserVideo(
  env: Bindings,
  videoId: number,
  userId: string,
) {
  return videoManagementService(env).deleteUserVideo(videoId, userId);
}

// Runtime composition stays outside the upload use cases. Preserve existing callers.
export function requestPresignedUpload(
  env: Bindings,
  userId: string,
  body: UploadRequest,
  idempotency?: CreationIdempotency,
) {
  return videoUploadService(env).requestPresignedUpload(
    userId,
    body,
    idempotency,
  );
}
export function confirmVideoUpload(
  env: Bindings,
  videoId: number,
  userId: string,
) {
  return videoUploadService(env).confirmVideoUpload(videoId, userId);
}
export function finishMultipartVideoUpload(
  env: Bindings,
  videoId: number,
  userId: string,
  parts: { partNumber: number; etag: string }[],
) {
  return videoUploadService(env).finishMultipartVideoUpload(
    videoId,
    userId,
    parts,
  );
}
export function abortVideoUpload(
  env: Bindings,
  videoId: number,
  userId: string,
) {
  return videoUploadService(env).abortVideoUpload(videoId, userId);
}
