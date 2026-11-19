import { requireFeature } from "../lib/deployment";
import {
  listVideosPage,
  getVideoDetail,
  mapVideoDetailRow,
  updateVideo,
  getVideoFileKey,
  deleteVideoCascade,
  createYoutubeVideo,
} from "../repositories/video-repository";
import { validateTranscriptSrt } from "../lib/srt";
import { videoOwnedBy } from "../repositories/membership-repository";
import { resolveStorageBytesForRelease } from "../lib/upload-reconcile";

import type { Bindings } from "../types/bindings";
import { processExternalTaskById } from "../lib/external-tasks";

import { createVideoManagementService } from "../features/videos/management-service";

export function videoManagementService(env: Bindings) {
  return createVideoManagementService({
    list: (...args) => listVideosPage(env, ...args),
    detail: (...args) => getVideoDetail(env, ...args),
    createYoutube: (...args) => createYoutubeVideo(env, ...args),
    update: (...args) => updateVideo(env, ...args),
    delete: (...args) => deleteVideoCascade(env, ...args),
    fileKey: (...args) => getVideoFileKey(env, ...args),
    ownedBy: (...args) => videoOwnedBy(env, ...args),
    mapDetail: (row) => mapVideoDetailRow(env, row),
    validateTranscript: validateTranscriptSrt,
    requireYoutube: () => requireFeature(env, "youtube"),
    storageBytes: (key) => resolveStorageBytesForRelease(env, key),
    dispatch: async (id) => {
      await processExternalTaskById(env, id);
    },
  });
}
