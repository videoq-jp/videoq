import type { Context } from "hono";
import * as tagService from "../../features/tags/service";
import * as videoService from "../../features/videos/service";
import type { AppEnv } from "../../types/bindings";
import { requireUserId, rpcError, type HandlersFor } from "./shared";

export function mediaLibraryHandlers(
  c: Context<AppEnv>,
  authenticatedUserId: string | null,
): HandlersFor<"tags"> & HandlersFor<"videos"> {
  const userId = () => requireUserId(authenticatedUserId);
  const uploadOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof videoService.UploadSessionError) return rpcError(error.code, error.message);
      throw error;
    }
  };
  return {
    "tags.list": async ({ limit, offset }) => {
      const { count, results } = await tagService.listTags(c.env, userId(), limit, offset);
      return { data: results, meta: { total: count, limit, offset } };
    },
    "tags.get": async ({ id }) => {
      const tag = await tagService.getTag(c.env, id, userId());
      if (!tag) return rpcError("NOT_FOUND", "Tag not found");
      return tag;
    },
    "tags.create": async ({ name, color }) => {
      const result = await tagService.createUserTag(c.env, userId(), name, color);
      if ("error" in result) return rpcError("BAD_REQUEST", result.error ?? "Bad request");
      return result.tag;
    },
    "tags.update": async ({ id, name, color }) => {
      const result = await tagService.updateUserTag(c.env, id, userId(), { name, color });
      if ("notFound" in result) return rpcError("NOT_FOUND", "Tag not found");
      if ("error" in result) return rpcError("BAD_REQUEST", result.error ?? "Bad request");
      return result.tag;
    },
    "tags.delete": async ({ id }) => {
      const result = await tagService.removeTag(c.env, id, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Tag not found");
      return { success: true };
    },

    "videos.list": async ({ limit, cursor, ...query }) => {
      const offset = cursor ?? 0;
      const { count, results } = await videoService.listUserVideos(
        c.env,
        userId(),
        query,
        limit,
        offset,
      );
      return { data: results, meta: { total: count, limit, offset } };
    },
    "videos.statusCounts": () => videoService.getUserVideoStats(c.env, userId()),
    "videos.get": async ({ id }) => {
      const video = await videoService.getUserVideo(c.env, id, userId());
      if (!video) return rpcError("NOT_FOUND", "Video not found");
      return video;
    },
    "videos.requestUpload": async ({ contentType, fileSize, ...input }) => {
      const result = await videoService.requestPresignedUpload(c.env, userId(), {
        filename: input.filename,
        content_type: contentType,
        file_size: fileSize,
        title: input.title,
        description: input.description ?? "",
        multipart: input.multipart,
        transcriptionLanguage: input.transcriptionLanguage,
      });
      if ("fieldError" in result && result.fieldError) {
        return rpcError("BAD_REQUEST", Object.values(result.fieldError)[0]?.[0] ?? "Invalid input", {
          appCode: "VALIDATION_ERROR", details: result.fieldError,
        });
      }
      if ("badRequest" in result && result.badRequest) {
        return rpcError("BAD_REQUEST", result.badRequest, {
          appCode: "code" in result ? result.code : "VALIDATION_ERROR",
        });
      }
      if (!result.video) return rpcError("INTERNAL_SERVER_ERROR", "Created video could not be loaded");
      if (!result.upload_url && !("multipart" in result)) return rpcError("INTERNAL_SERVER_ERROR", "Upload URL could not be created");
      return { video: result.video, upload_url: result.upload_url, ...("multipart" in result ? { multipart: result.multipart } : {}) };
    },
    "videos.confirmUpload": async ({ id }) => {
      const result = await videoService.confirmVideoUpload(c.env, id, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Video not found");
      if ("badState" in result) return rpcError("BAD_REQUEST", result.message ?? "Bad request");
      if (!result.video) return rpcError("INTERNAL_SERVER_ERROR", "Video could not be loaded");
      return result.video;
    },
    "videos.uploadPartUrl": ({ id, partNumber }) => uploadOperation(() =>
      videoService.getMultipartUploadPartUrl(c.env, id, userId(), partNumber)),
    "videos.completeMultipartUpload": ({ id, parts }) => uploadOperation(async () => {
      const video = await videoService.finishMultipartVideoUpload(c.env, id, userId(), parts);
      if (!video) return rpcError("NOT_FOUND", "Video not found");
      return video;
    }),
    "videos.abortUpload": ({ id }) => videoService.abortVideoUpload(c.env, id, userId()),
    "videos.createYoutube": async ({ youtubeUrl, title, description }) => {
      const result = await videoService.createUserYoutubeVideo(c.env, userId(), {
        youtube_url: youtubeUrl,
        title,
        description: description ?? "",
      });
      if ("fieldError" in result && result.fieldError) {
        return rpcError("BAD_REQUEST", Object.values(result.fieldError)[0]?.[0] ?? "Invalid input");
      }
      if ("idempotencyConflict" in result) {
        return rpcError("CONFLICT", "Idempotency conflict");
      }
      if (!result.video) return rpcError("INTERNAL_SERVER_ERROR", "Created video could not be loaded");
      return result.video;
    },
    "videos.update": async ({ id, ...patch }) => {
      const result = await videoService.patchUserVideo(c.env, id, userId(), patch);
      if ("notFound" in result) return rpcError("NOT_FOUND", "Video not found");
      if ("fieldError" in result) {
        return rpcError("BAD_REQUEST", result.fieldError
          ? Object.values(result.fieldError)[0]?.[0] ?? "Invalid input"
          : "Invalid input");
      }
      return result.video;
    },
    "videos.delete": async ({ id }) => {
      const result = await videoService.deleteUserVideo(c.env, id, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Video not found");
      return { success: true };
    },
  };
}
