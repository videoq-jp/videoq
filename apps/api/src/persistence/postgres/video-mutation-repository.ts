import { and, eq, inArray, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { sceneEmbeddings,mcpIdempotencyRecords,videos } from "../../db/schema";
import { insertJobTask,insertStorageCleanupTask } from "./external-task-repository";
import { buildJobMessage,JOB_REINDEX_VIDEO_TRANSCRIPT } from "../../lib/job-message";
import { parseReservedBytesFromFileKey } from "../../lib/upload";
import { refundUnconfirmedUpload } from "./storage-quota";
import { readVideoDetail,videoDetailSelect } from "./video-read-repository";
import type { Bindings } from "../../types/bindings";
import { validateVideoDeletionOptions,type VideoMutationRepository } from "../contracts/video-mutation-repository";

export async function updateVideo(
  env: Bindings,
  videoId: number,
  userId: string,
  fields: { title?: string; description?: string; transcript?: string },
): Promise<
  | { notFound: true }
  | {
      row: NonNullable<Awaited<ReturnType<typeof readVideoDetail>>>;
      reindexTaskId: number | null;
    }
> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      // Compare under the row lock without transferring a potentially large transcript.
      const [changes] = await tx
        .select({
          title: fields.title === undefined
            ? sql<boolean>`false`
            : sql<boolean>`${videos.title} IS DISTINCT FROM ${fields.title}`,
          description: fields.description === undefined
            ? sql<boolean>`false`
            : sql<boolean>`${videos.description} IS DISTINCT FROM ${fields.description}`,
          transcript: fields.transcript === undefined
            ? sql<boolean>`false`
            : sql<boolean>`COALESCE(${videos.transcript}, '') IS DISTINCT FROM ${fields.transcript}`,
        })
        .from(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
        .for("update")
        .limit(1);
      if (!changes) return { notFound: true } as const;

      const patch: { title?: string; description?: string; transcript?: string } = {};
      if (changes.title) patch.title = fields.title;
      if (changes.description) patch.description = fields.description;
      if (changes.transcript) patch.transcript = fields.transcript;
      const row = Object.keys(patch).length > 0
        ? (await tx.update(videos).set(patch)
          .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
          .returning(videoDetailSelect))[0]
        : await readVideoDetail(tx, videoId, userId);
      if (!row) throw new Error("Locked video disappeared.");

      if (changes.title) {
        await tx
          .update(sceneEmbeddings)
          .set({
            langchainMetadata: sql`jsonb_set(
              COALESCE(${sceneEmbeddings.langchainMetadata}::jsonb, '{}'::jsonb),
              '{video_title}',
              to_jsonb(${fields.title!}::text)
            )`,
          })
          .where(eq(sceneEmbeddings.videoId, videoId));
      }
      let reindexTaskId: number | null = null;
      if (changes.transcript) {
        const message = buildJobMessage(JOB_REINDEX_VIDEO_TRANSCRIPT, {
          video_id: videoId,
        });
        const task = await insertJobTask(tx, { message });
        reindexTaskId = task.id;
      }
      return {
        row,
        reindexTaskId,
      } as const;
    }),
  );
}

export async function deleteVideoCascade(
  env: Bindings,
  videoId: number,
  userId: string,
  options: {
    expectedStatus?: string;
    expectedFileKey?: string;
    fallbackStorageBytes?: number | null;
    /** Recheck abandonment under the row lock, after a concurrent part request. */
    inactiveBefore?: Date;
  } = {},
): Promise<
  | { deleted: false; cleanupTaskId: null }
  | { deleted: true; cleanupTaskId: number | null }
> {
  return withDb(env, async (db) => {
    return db.transaction(async (tx) => {
      const locked = await tx
        .select({ status: videos.status, file: videos.file, multipart: videos.multipartUpload,
          heartbeat: videos.uploadHeartbeatAt, uploadPeriod: videos.uploadUsagePeriodStart })
        .from(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
        .for("update")
        .limit(1);
      if (
        locked.length === 0 ||
        (options.expectedStatus !== undefined &&
          locked[0].status !== options.expectedStatus) ||
        (options.expectedFileKey !== undefined &&
          locked[0].file !== options.expectedFileKey)
        || (options.inactiveBefore !== undefined && locked[0].heartbeat !== null &&
          new Date(locked[0].heartbeat) >= options.inactiveBefore)
      ) {
        return { deleted: false, cleanupTaskId: null } as const;
      }

      const fileKey = locked[0].file || null;
      const cleanupBytes = fileKey
        ? (parseReservedBytesFromFileKey(fileKey) ??
          options.fallbackStorageBytes ??
          null)
        : null;
      const cleanupTaskId = fileKey
        ? await insertStorageCleanupTask(tx, {
            dedupeKey: `storage:video:${videoId}`,
            userId,
            fileKey,
            bytes: cleanupBytes,
            ...(locked[0].multipart ? { multipartUploadId: locked[0].multipart.uploadId } : {}),
          })
        : null;

      // A completed upload consumes its month's allowance even after deletion.
      // Row locking + the delete make abort refunds idempotent. A previous
      // month's reservation cannot subtract from a new month's usage.
      if (locked[0].status === "uploading" && locked[0].uploadPeriod && cleanupBytes) {
        await refundUnconfirmedUpload(tx, userId, cleanupBytes, locked[0].uploadPeriod);
      }

      await tx
        .delete(mcpIdempotencyRecords)
        .where(
          and(
            eq(mcpIdempotencyRecords.userId, userId),
            eq(mcpIdempotencyRecords.resourceId, videoId),
            inArray(mcpIdempotencyRecords.action, [
              "request_video_upload",
              "create_youtube_video",
            ]),
          ),
        );

      // No FK; remove vector rows so orphan embeddings do not linger.
      await tx.execute(sql`DELETE FROM scene_embeddings WHERE video_id = ${videoId}`);

      // FK cascades remove tags and course memberships.
      await tx
        .delete(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId)));
      return { deleted: true, cleanupTaskId } as const;
    });
  });
}
export function createPostgresVideoMutationRepository(env: Bindings): VideoMutationRepository {
 return {update: (videoId,userId,fields)=>updateVideo(env,videoId,userId,fields),
 delete: async (videoId,userId,options={})=>{validateVideoDeletionOptions(options);return await deleteVideoCascade(env,videoId,userId,options);}};
}
