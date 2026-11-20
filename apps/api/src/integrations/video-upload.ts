import { buildPendingUploadFileKey } from "../lib/upload";
import { createVideoUploadService } from "../features/videos/upload-service";
import type { Bindings } from "../types/bindings";
import {
  reserveAndCreatePendingVideo, getVideoUploadState, confirmUploadedVideo,
  deleteVideoCascade, getVideoDetail,
} from "../repositories/video-repository";
import { initializeMultipartUpload, completeMultipartVideoUpload } from "../repositories/multipart-upload-repository";
import { getR2ObjectSize, isS3Storage, putMediaObject, presignR2Put } from "./media";
import { processExternalTaskById } from "../lib/external-tasks";
import { armMaintenance } from "../lib/task-scheduler";
import { ABANDONED_UPLOAD_MS } from "../lib/upload-reconcile";

/** Request-local composition shared by HTTP, tRPC and MCP entrypoints. */
export function videoUploadService(env: Bindings) {
  return createVideoUploadService<ReadableStream>({
    newFileKey: buildPendingUploadFileKey,
    videos: {
      reserveUpload: input => reserveAndCreatePendingVideo(env, input.userId, input.storageBytes,
        input.fileKey, input.title, input.description, input.idempotency, input.transcriptionLanguage),
      getUploadState: (id, user) => getVideoUploadState(env, id, user),
      confirmUpload: input => confirmUploadedVideo(env, input.videoId, input.userId, input.fileKey),
      delete: (id, user, options) => deleteVideoCascade(env, id, user, options),
      getDetail: (id, user, options) => getVideoDetail(env, id, user, options),
    },
    storage: {
      presigned: isS3Storage(env),
      signPut: (key, type, bytes) => presignR2Put(env, key, type, bytes),
      size: key => getR2ObjectSize(env, key),
      put: (key, body, type) => putMediaObject(env, key, body, type),
    },
    multipart: {
      initialize: (id, user, type) => initializeMultipartUpload(env, id, user, type),
      complete: (id, user, parts) => completeMultipartVideoUpload(env, id, user, parts),
    },
    tasks: {
      dispatch: id => processExternalTaskById(env, id),
      scheduleRecovery: () => armMaintenance(env, Date.now() + ABANDONED_UPLOAD_MS),
    },
    reportCleanupFailure: () => console.error(JSON.stringify({
      level: "error", event: "best_effort_failed", operation: "presigned_upload_cleanup",
    })),
  });
}
