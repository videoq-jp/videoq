import {
  videoDeletionAllowed,
  videoCleanup,
  videoAbortRefundAllowed,
  videoTranscriptChanged,
} from "../../domain/media/video-mutation";
import { videoMutationDrizzleLogic } from "../video-mutation-policy-sql";
import { and, eq, sql, exists, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  videos,
  users,
  mutationReceipts as receipts,
  videoIndexVersions,
  scenes,
  sceneStaging,
  sceneIndexRuns,
  externalTasks,
  mcpIdempotencyRecords,
} from "../../db/schema/sqlite";
import {
  buildJobMessage,
  JOB_REINDEX_VIDEO_TRANSCRIPT,
} from "../../lib/job-message";
import type { VideoDetailRow } from "../contracts/video-read-repository";
import {
  validateVideoDeletionOptions,
  type VideoMutationRepository,
} from "../contracts/video-mutation-repository";
import { videoDetailProjection } from "./video-read-repository";
import {
  enqueueCurrentSceneDeletes,
  enqueueStagedSceneDeletes,
} from "./scene-index-writer";

export function createD1VideoMutationRepository(
  database: D1Database,
  onIndexWork?: () => Promise<void>,
  deletionFence?: import("drizzle-orm").SQL,
): VideoMutationRepository {
  const db = createD1Connection(database);
  const gate = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  const notify = async () => {
    try {
      await onIndexWork?.();
    } catch {
      /* Durable work is recovered by scheduled maintenance. */
    }
  };
  return {
    async update(videoId, userId, fields) {
      const token = crypto.randomUUID(),
        transcriptToken = token + ":transcript";
      const message = buildJobMessage(JOB_REINDEX_VIDEO_TRANSCRIPT, {
        video_id: videoId,
      });
      const dedupeKey = `job:${message.job_id}`;
      const sourceReceipt = alias(receipts, "source_receipt");
      const results = await runD1Batch(database, [
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'video_update'`,
                resourceId: videos.id,
                effectApplied: videoTranscriptChanged(
                  sql`${fields.transcript ?? null} IS NOT NULL`,
                  sql`coalesce(${videos.transcript},'') IS NOT ${fields.transcript ?? null}`,
                  videoMutationDrizzleLogic,
                ),
              }),
            )
            .from(videos)
            .where(and(eq(videos.id, videoId), eq(videos.userId, userId))),
        ),
        db
          .update(videos)
          .set({
            title: fields.title ?? sql`${videos.title}`,
            description: fields.description ?? sql`${videos.description}`,
            transcript: fields.transcript ?? sql`${videos.transcript}`,
          })
          .where(and(eq(videos.id, videoId), gate(token))),
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${transcriptToken}`,
                kind: sql`'video_transcript_update'`,
                resourceId: sourceReceipt.resourceId,
              }),
            )
            .from(sourceReceipt)
            .where(
              and(
                eq(sourceReceipt.token, token),
                eq(sourceReceipt.effectApplied, true),
              ),
            ),
        ),
        db
          .insert(videoIndexVersions)
          .select(
            db
              .select(
                insertSelectFields(videoIndexVersions, {
                  videoId: sql`${videoId}`,
                  revision: sql`${crypto.randomUUID()}`,
                }),
              )
              .from(receipts)
              .where(eq(receipts.token, transcriptToken)),
          )
          .onConflictDoUpdate({
            target: videoIndexVersions.videoId,
            set: { revision: sql`excluded.revision` },
          }),
        enqueueCurrentSceneDeletes(database, videoId, transcriptToken),
        enqueueStagedSceneDeletes(database, videoId, transcriptToken),
        db
          .delete(scenes)
          .where(and(eq(scenes.videoId, videoId), gate(transcriptToken))),
        db
          .delete(sceneStaging)
          .where(
            and(
              inArray(
                sceneStaging.runId,
                db
                  .select({ id: sceneIndexRuns.id })
                  .from(sceneIndexRuns)
                  .where(eq(sceneIndexRuns.videoId, videoId)),
              ),
              gate(transcriptToken),
            ),
          ),
        db.insert(externalTasks).select(
          db
            .select(
              insertSelectFields(externalTasks, {
                kind: sql`'sqs_job'`,
                payload: sql`${JSON.stringify({ message })}`,
                dedupeKey: sql`${dedupeKey}`,
              }),
            )
            .from(receipts)
            .where(eq(receipts.token, transcriptToken)),
        ),
        db
          .select(videoDetailProjection)
          .from(videos)
          .where(
            and(eq(videos.id, videoId), eq(videos.userId, userId), gate(token)),
          ),
        db
          .select({ id: externalTasks.id })
          .from(externalTasks)
          .where(eq(externalTasks.dedupeKey, dedupeKey)),
        db
          .delete(receipts)
          .where(inArray(receipts.token, [token, transcriptToken])),
      ]);
      const raw = results[9].results[0];
      if (!raw) return { notFound: true };
      const row = raw as VideoDetailRow;
      if (typeof row.visual_processing === "string")
        row.visual_processing = JSON.parse(row.visual_processing);
      const reindexTaskId = results[10].results[0]
        ? Number(results[10].results[0].id)
        : null;
      if (reindexTaskId !== null) await notify();
      return { row, reindexTaskId };
    },
    async delete(videoId, userId, options = {}) {
      validateVideoDeletionOptions(options);
      for (let attempt = 0; attempt < 5; attempt++) {
        const video = await db
          .select({
            status: videos.status,
            file: videos.file,
            multipart: videos.multipartUpload,
            heartbeat: videos.uploadHeartbeatAt,
            uploadPeriod: videos.uploadUsagePeriodStart,
          })
          .from(videos)
          .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
          .get();
        if (!video || !videoDeletionAllowed(video, options))
          return { deleted: false, cleanupTaskId: null };
        const token = crypto.randomUUID();
        const { fileKey, bytes } = videoCleanup(
          video.file,
          options.fallbackStorageBytes,
        );
        const cleanupKey = `storage:video:${videoId}`;
        const payload = {
          user_id: userId,
          file_key: fileKey,
          bytes,
          ...(video.multipart
            ? { multipart_upload_id: video.multipart.uploadId }
            : {}),
        };
        const results = await runD1Batch(database, [
          db.insert(receipts).select(
            db
              .select(
                insertSelectFields(receipts, {
                  token: sql`${token}`,
                  kind: sql`'video_delete'`,
                  resourceId: videos.id,
                }),
              )
              .from(videos)
              .where(
                and(
                  eq(videos.id, videoId),
                  eq(videos.userId, userId),
                  eq(videos.status, video.status),
                  eq(videos.file, video.file),
                  sql`json(${videos.multipartUpload}) IS json(${video.multipart ? JSON.stringify(video.multipart) : null})`,
                  sql`${videos.uploadHeartbeatAt} IS ${video.heartbeat}`,
                  sql`${videos.uploadUsagePeriodStart} IS ${video.uploadPeriod}`,
                  deletionFence,
                ),
              ),
          ),
          db
            .insert(externalTasks)
            .select(
              db
                .select(
                  insertSelectFields(externalTasks, {
                    kind: sql`'storage_cleanup'`,
                    payload: sql`${JSON.stringify(payload)}`,
                    dedupeKey: sql`${cleanupKey}`,
                  }),
                )
                .from(receipts)
                .where(
                  and(eq(receipts.token, token), sql`${fileKey} IS NOT NULL`),
                ),
            )
            .onConflictDoNothing({ target: externalTasks.dedupeKey }),
          enqueueCurrentSceneDeletes(database, videoId, token),
          enqueueStagedSceneDeletes(database, videoId, token),
          db
            .update(users)
            .set({
              usedUploadBytes: sql`max(0,${users.usedUploadBytes}-${bytes ?? 0})`,
            })
            .where(
              and(
                eq(users.id, userId),
                sql`${users.uploadUsagePeriodStart}=${video.uploadPeriod}`,
                videoAbortRefundAllowed(
                  sql`${video.status}`,
                  sql`${bytes ?? 0}`,
                  videoMutationDrizzleLogic,
                ),
                gate(token),
              ),
            ),
          db
            .delete(mcpIdempotencyRecords)
            .where(
              and(
                eq(mcpIdempotencyRecords.userId, userId),
                eq(mcpIdempotencyRecords.resourceId, videoId),
                inArray(mcpIdempotencyRecords.action, [
                  "request_video_upload",
                  "create_youtube_video",
                ]),
                gate(token),
              ),
            ),
          db
            .delete(videos)
            .where(
              and(
                eq(videos.id, videoId),
                eq(videos.userId, userId),
                gate(token),
              ),
            )
            .returning({ id: videos.id }),
          db
            .select({ id: externalTasks.id })
            .from(externalTasks)
            .where(
              and(
                eq(externalTasks.dedupeKey, cleanupKey),
                sql`${fileKey} IS NOT NULL`,
              ),
            ),
          db.delete(receipts).where(eq(receipts.token, token)),
        ]);
        if (results[6].results.length) {
          await notify();
          return {
            deleted: true,
            cleanupTaskId: results[7].results[0]
              ? Number(results[7].results[0].id)
              : null,
          };
        }
      }
      throw new Error(
        "Video changed repeatedly during deletion; retry the operation",
      );
    },
  };
}
