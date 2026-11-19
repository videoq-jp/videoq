import { videoUploadService } from "../../integrations/video-upload";
import type { UploadRequest } from "./upload-service";
export { multipartUnavailableBody, type MultipartVideoResult } from "./upload-service";
import { requireFeature } from "../../lib/deployment";
import {
  listVideosPage,
  getVideoDetail,
  mapVideoDetailRow,
  updateVideo,
  getVideoFileKey,
  deleteVideoCascade,
  createYoutubeVideo,
} from "../../repositories/video-repository";
import { validateTranscriptSrt } from "../../lib/srt";
import { videoOwnedBy } from "../../repositories/membership-repository";
import { resolveStorageBytesForRelease } from "../../lib/upload-reconcile";
import {
  extractYoutubeVideoId,
  INVALID_YOUTUBE_URL_MESSAGE,
} from "../../lib/youtube";
import type { Bindings } from "../../types/bindings";
import { processExternalTaskById } from "../../lib/external-tasks";
import type { CreationIdempotency } from "../../repositories/mcp-idempotency-repository";

export { getMultipartUploadPartUrl, UploadSessionError } from "../../repositories/multipart-upload-repository";

export {
  countVideosByStatus as getUserVideoStats,
  getVideoDetail as getUserVideo,
} from "../../repositories/video-repository";

type YoutubeCreateRequest = {
  youtube_url: string;
  title: string;
  description: string;
};

async function dispatchCleanupTask(
  env: Bindings,
  taskId: number | null,
): Promise<void> {
  if (taskId !== null) await processExternalTaskById(env, taskId);
}

export async function listUserVideos(
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
  return listVideosPage(
    env,
    userId,
    {
      keyword: query.q?.trim() ?? "",
      statusFilter: query.status?.trim() ?? "",
      sortKey: query.ordering?.trim() ?? "",
      tagIds: query.tags ?? null,
    },
    limit,
    offset,
  );
}

export async function createUserYoutubeVideo(
  env: Bindings,
  userId: string,
  body: YoutubeCreateRequest,
  idempotency?: CreationIdempotency,
) {
  requireFeature(env, "youtube");
  const youtubeVideoId = extractYoutubeVideoId(body.youtube_url);
  if (youtubeVideoId === null) {
    return {
      fieldError: { youtube_url: [INVALID_YOUTUBE_URL_MESSAGE] },
    } as const;
  }

  const created = await createYoutubeVideo(
    env,
    userId,
    {
      sourceUrl: body.youtube_url,
      youtubeVideoId,
      title: body.title,
      description: body.description,
    },
    idempotency,
  );
  if ("idempotencyConflict" in created) return created;
  if (created.taskId !== null) {
    await processExternalTaskById(env, created.taskId);
  }
  return {
    video: await getVideoDetail(env, created.videoId, userId),
    reused: created.reused,
  } as const;
}

export async function patchUserVideo(
  env: Bindings,
  videoId: number,
  userId: string,
  fields: { title?: string; description?: string; transcript?: string },
) {
  if (fields.transcript !== undefined) {
    const srtErr = validateTranscriptSrt(fields.transcript);
    if (srtErr) {
      if (!(await videoOwnedBy(env, videoId, userId))) return { notFound: true } as const;
      return { fieldError: { transcript: [srtErr] } } as const;
    }
  }

  const res = await updateVideo(env, videoId, userId, fields);
  if ("notFound" in res) return { notFound: true } as const;

  if (res.reindexTaskId !== null) {
    await processExternalTaskById(env, res.reindexTaskId);
  }
  return { video: await mapVideoDetailRow(env, res.row) } as const;
}

export async function deleteUserVideo(
  env: Bindings,
  videoId: number,
  userId: string,
) {
  const info = await getVideoFileKey(env, videoId, userId);
  if (!info.found) return { notFound: true } as const;

  const fileSize = await resolveStorageBytesForRelease(env, info.fileKey);

  const deleted = await deleteVideoCascade(env, videoId, userId, {
    fallbackStorageBytes: fileSize,
  });
  if (!deleted.deleted) return { notFound: true } as const;

  await dispatchCleanupTask(env, deleted.cleanupTaskId);

  return { ok: true } as const;
}

// Runtime composition stays outside the upload use cases. Preserve existing callers.
export function requestPresignedUpload(env: Bindings, userId: string, body: UploadRequest, idempotency?: CreationIdempotency) {
  return videoUploadService(env).requestPresignedUpload(userId, body, idempotency);
}
export function confirmVideoUpload(env: Bindings, videoId: number, userId: string) {
  return videoUploadService(env).confirmVideoUpload(videoId, userId);
}
export function finishMultipartVideoUpload(env: Bindings, videoId: number, userId: string, parts: { partNumber: number; etag: string }[]) {
  return videoUploadService(env).finishMultipartVideoUpload(videoId, userId, parts);
}
export function abortVideoUpload(env: Bindings, videoId: number, userId: string) {
  return videoUploadService(env).abortVideoUpload(videoId, userId);
}
export function createVideoFromMultipart(env: Bindings, userId: string, form: Record<string, string | File>) {
  return videoUploadService(env).createVideoFromMultipart(userId, form);
}
