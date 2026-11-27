import {
  insertSelectFields,
  insertSelectValues,
  runD1Batch,
} from "../../db/d1/query-builders";
import {
  pendingUploadedVideo,
  pendingYoutubeVideo,
  uploadConfirmationTransition,
  videoCreationReplayAllowed,
} from "../../domain/media/video-creation";
import { validateCreationIdempotency } from "../../application/creation-idempotency";
import {
  failedUploadReservation,
  quotaAllowsAdditional,
  validateUploadReservationBytes,
} from "../../domain/billing/quota-policy";
import { quotaDrizzleComparison } from "../quota-policy-sql";
import { and, eq, sql, notExists } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  videos,
  users,
  mcpIdempotencyRecords as records,
  externalTasks,
} from "../../db/schema/sqlite";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";
import type { CreationIdempotency } from "../contracts/creation-idempotency";
import type { VideoUploadRepository } from "../contracts/video-upload-repository";

const CURRENT_MONTH = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now','start of month')`;
const CURRENT_UPLOAD_BYTES = sql`CASE WHEN strftime('%Y-%m',${users.uploadUsagePeriodStart})=strftime('%Y-%m','now') THEN ${users.usedUploadBytes} ELSE 0 END`;

function receipt(
  input: CreationIdempotency | undefined,
  action: CreationIdempotency["action"],
) {
  validateCreationIdempotency(input, action);
  return (
    input ?? {
      action,
      key: `internal:${crypto.randomUUID()}`,
      requestHash: "0".repeat(64),
    }
  );
}

/** Atomic D1 batches implement each business operation; no interactive transactions. */
export function createD1VideoUploadRepository(
  database: D1Database,
): VideoUploadRepository {
  const db = createD1Connection(database);
  const ownedReceipt = (userId: string, identity: CreationIdempotency) =>
    and(
      eq(records.userId, userId),
      eq(records.action, identity.action),
      eq(records.key, identity.key),
    );
  const rememberCreatedVideo = (
    userId: string,
    identity: CreationIdempotency,
  ) =>
    db.insert(records).select(
      db
        .select(
          insertSelectFields(records, {
            userId: sql`${userId}`,
            action: sql`${identity.action}`,
            key: sql`${identity.key}`,
            requestHash: sql`${identity.requestHash}`,
            resourceId: sql`last_insert_rowid()`,
          }),
        )
        .from(users)
        .where(and(eq(users.id, userId), sql`changes()=1`)),
    );
  const readCreatedVideo = (userId: string, identity: CreationIdempotency) =>
    db
      .select({
        request_hash: records.requestHash,
        resource_id: records.resourceId,
        video_id: sql<number | null>`${videos.id}`.as("video_id"),
        file: videos.file,
      })
      .from(records)
      .leftJoin(
        videos,
        and(
          eq(videos.id, records.resourceId),
          eq(videos.userId, records.userId),
        ),
      )
      .where(ownedReceipt(userId, identity));
  const forgetInternalReceipt = (
    userId: string,
    identity: CreationIdempotency,
    retain: boolean,
  ) =>
    db
      .delete(records)
      .where(and(ownedReceipt(userId, identity), sql`${Number(retain)}=0`));

  return {
    async reserveUpload(p) {
      validateUploadReservationBytes(p.storageBytes);
      const identity = receipt(p.idempotency, "request_video_upload");
      const initial = pendingUploadedVideo(p);
      const result = await runD1Batch(database, [
        db.insert(videos).select(
          db
            .select(
              insertSelectValues(videos, {
                ...initial,
                transcriptionLanguage: initial.transcriptionLanguage ?? null,
                uploadUsagePeriodStart: CURRENT_MONTH,
                uploadedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
              }),
            )
            .from(users)
            .where(
              and(
                eq(users.id, initial.userId),
                sql`${users.isOverQuota} IS NOT TRUE`,
                quotaAllowsAdditional(
                  sql`${users.usedStorageBytes}`,
                  sql`floor(${users.storageLimitGb}*1073741824)`,
                  sql`${p.storageBytes}`,
                  quotaDrizzleComparison,
                ),
                quotaAllowsAdditional(
                  CURRENT_UPLOAD_BYTES,
                  sql`floor(${users.monthlyUploadLimitGb}*1073741824)`,
                  sql`${p.storageBytes}`,
                  quotaDrizzleComparison,
                ),
                sql`${users.usedStorageBytes}<=9007199254740991-${p.storageBytes}`,
                sql`(${CURRENT_UPLOAD_BYTES})<=9007199254740991-${p.storageBytes}`,
                notExists(
                  db
                    .select({ key: records.key })
                    .from(records)
                    .where(ownedReceipt(p.userId, identity)),
                ),
              ),
            ),
        ),
        rememberCreatedVideo(p.userId, identity),
        db
          .update(users)
          .set({
            usedStorageBytes: sql`${users.usedStorageBytes}+${p.storageBytes}`,
            usedUploadBytes: sql`(${CURRENT_UPLOAD_BYTES})+${p.storageBytes}`,
            uploadUsagePeriodStart: CURRENT_MONTH,
          })
          .where(and(eq(users.id, p.userId), sql`changes()=1`)),
        readCreatedVideo(p.userId, identity),
        db
          .select({
            overQuota: users.isOverQuota,
            storageLimitGb: users.storageLimitGb,
            usedStorageBytes: users.usedStorageBytes,
            monthlyUploadLimitGb: users.monthlyUploadLimitGb,
          })
          .from(users)
          .where(eq(users.id, p.userId)),
        forgetInternalReceipt(p.userId, identity, Boolean(p.idempotency)),
      ]);
      const row = result[3].results[0];
      if (row) {
        if (
          !videoCreationReplayAllowed(
            "uploaded",
            row.request_hash === identity.requestHash,
            row.video_id !== null,
          )
        )
          return { idempotencyConflict: true };
        return {
          ok: true,
          videoId: Number(row.video_id),
          fileKey: String(row.file),
          reused: result[0].meta.changes === 0,
        };
      }
      const state = result[4].results[0];
      const failure = failedUploadReservation(
        state
          ? {
              overQuota: Boolean(state.is_over_quota),
              storageLimitGb:
                state.storage_limit_gb === null
                  ? null
                  : Number(state.storage_limit_gb),
              storageUsedBytes: Number(state.used_storage_bytes),
              monthlyLimitGb:
                state.monthly_upload_limit_gb === null
                  ? null
                  : Number(state.monthly_upload_limit_gb),
            }
          : null,
        p.storageBytes,
      );
      if (failure) return failure;
      throw new Error("Upload quota exceeds the safe integer range.");
    },
    async createYoutube(p) {
      const identity = receipt(p.idempotency, "create_youtube_video");
      const initial = pendingYoutubeVideo(p);
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: 0 });
      const dedupeKey = `job:${message.job_id}`;
      const result = await runD1Batch(database, [
        db.insert(videos).select(
          db
            .select(
              insertSelectValues(videos, {
                ...initial,
                uploadedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
              }),
            )
            .from(users)
            .where(
              and(
                eq(users.id, initial.userId),
                notExists(
                  db
                    .select({ key: records.key })
                    .from(records)
                    .where(ownedReceipt(p.userId, identity)),
                ),
              ),
            ),
        ),
        rememberCreatedVideo(p.userId, identity),
        db.insert(externalTasks).select(
          db
            .select(
              insertSelectFields(externalTasks, {
                kind: sql`'sqs_job'`,
                payload: sql`json_set(${JSON.stringify({ message })},'$.message.payload.video_id',${records.resourceId})`,
                dedupeKey: sql`${dedupeKey}`,
              }),
            )
            .from(records)
            .where(and(ownedReceipt(p.userId, identity), sql`changes()=1`)),
        ),
        readCreatedVideo(p.userId, identity),
        db
          .select({ id: externalTasks.id })
          .from(externalTasks)
          .where(eq(externalTasks.dedupeKey, dedupeKey)),
        forgetInternalReceipt(p.userId, identity, Boolean(p.idempotency)),
      ]);
      const row = result[3].results[0];
      if (!row) throw new Error("Video owner not found.");
      if (
        !videoCreationReplayAllowed(
          "youtube",
          row.request_hash === identity.requestHash,
          row.video_id !== null,
        )
      )
        return { idempotencyConflict: true };
      const task = result[4].results[0];
      return {
        videoId: Number(row.resource_id),
        taskId: task ? Number(task.id) : null,
        jobId: task ? message.job_id : "",
        reused: result[0].meta.changes === 0,
      };
    },
    async confirmUpload({ videoId, userId, fileKey }) {
      const transition = uploadConfirmationTransition();
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, {
        video_id: videoId,
      });
      const dedupeKey = `job:${message.job_id}`;
      const matches = and(
        eq(videos.id, videoId),
        eq(videos.userId, userId),
        eq(videos.status, transition.from),
        eq(videos.file, fileKey),
      );
      const result = await runD1Batch(database, [
        db.insert(externalTasks).select(
          db
            .select(
              insertSelectValues(externalTasks, {
                kind: "sqs_job",
                payload: { message },
                dedupeKey,
              }),
            )
            .from(videos)
            .where(matches),
        ),
        db
          .update(videos)
          .set(transition.changes)
          .where(and(matches, sql`changes()=1`)),
        db
          .select({ id: externalTasks.id })
          .from(externalTasks)
          .where(eq(externalTasks.dedupeKey, dedupeKey)),
      ]);
      const task = result[2].results[0];
      return task
        ? { videoId, taskId: Number(task.id), jobId: message.job_id }
        : false;
    },
    async getUploadState(videoId, userId) {
      const [row] = await db
        .select({ status: videos.status, file: videos.file })
        .from(videos)
        .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
        .limit(1);
      return row
        ? { found: true, status: row.status, fileKey: row.file || null }
        : { found: false };
    },
  };
}
