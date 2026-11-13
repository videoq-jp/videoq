import { and, eq, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { users, videos } from "../../db/schema";
import { insertJobTask } from "./external-task-repository";
import { findIdempotentResource, recordIdempotentResource, type CreationIdempotency } from "./creation-idempotency";
import { reserveUploadInTransaction } from "./storage-quota";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";
import type { Bindings } from "../../types/bindings";
import type { OutboxedVideoJob, PendingVideoReservation, VideoUploadRepository } from "../contracts/video-upload-repository";

export async function createYoutubeVideo(
  env: Bindings,
  userId: string,
  params: { sourceUrl: string; youtubeVideoId: string; title: string; description: string },
  idempotency?: CreationIdempotency,
): Promise<
  | (Omit<OutboxedVideoJob, "taskId"> & {
      taskId: number | null;
      reused: boolean;
    })
  | { idempotencyConflict: true }
> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`);
      const existing = await findIdempotentResource(tx, userId, idempotency);
      if (existing.found) {
        if (existing.conflict) return { idempotencyConflict: true } as const;
        return {
          videoId: existing.resourceId,
          taskId: null,
          jobId: "",
          reused: true,
        } as const;
      }
      const rows = await tx
        .insert(videos)
        .values({
          userId,
          file: "",
          title: params.title,
          description: params.description,
          status: "pending",
          sourceType: "youtube",
          sourceUrl: params.sourceUrl,
          youtubeVideoId: params.youtubeVideoId,
          transcript: "",
          errorMessage: "",
          uploadedAt: sql`CURRENT_TIMESTAMP`,
        })
        .returning({ id: videos.id });
      const videoId = Number(rows[0].id);
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: videoId });
      const task = await insertJobTask(tx, { message });
      await recordIdempotentResource(tx, userId, idempotency, videoId);
      return {
        videoId,
        taskId: task.id,
        jobId: message.job_id,
        reused: false,
      };
    }),
  );
}

export async function getVideoUploadState(
  env: Bindings,
  videoId: number,
  userId: string,
): Promise<{ found: false } | { found: true; status: string; fileKey: string | null }> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({ status: videos.status, file: videos.file })
      .from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
      .limit(1);
    if (rows.length === 0) return { found: false } as const;
    return { found: true, status: rows[0].status, fileKey: rows[0].file || null } as const;
  });
}

export async function confirmUploadedVideo(
  env: Bindings,
  videoId: number,
  userId: string,
  fileKey: string,
): Promise<false | OutboxedVideoJob> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const rows = await tx
        .update(videos)
        .set({ status: "pending", errorMessage: "" })
        .where(and(
          eq(videos.id, videoId), eq(videos.userId, userId),
          eq(videos.status, "uploading"), eq(videos.file, fileKey),
        ))
        .returning({ id: videos.id });
      if (rows.length === 0) return false;
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: videoId });
      const task = await insertJobTask(tx, { message });
      return { videoId, taskId: task.id, jobId: message.job_id };
    }),
  );
}

export async function reserveAndCreatePendingVideo(
  env: Bindings,
  userId: string,
  storageBytes: number,
  fileKey: string,
  title: string,
  description: string,
  idempotency?: CreationIdempotency,
  transcriptionLanguage?: string,
): Promise<PendingVideoReservation> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!owner) throw new Error("Quota owner not found.");
      const existing = await findIdempotentResource(tx, userId, idempotency);
      if (existing.found) {
        if (existing.conflict) return { idempotencyConflict: true } as const;
        const rows = await tx
          .select({ id: videos.id, file: videos.file })
          .from(videos)
          .where(and(eq(videos.id, existing.resourceId), eq(videos.userId, userId)))
          .limit(1);
        const video = rows[0];
        if (!video) return { idempotencyConflict: true } as const;
        return {
          ok: true as const,
          videoId: Number(video.id),
          fileKey: video.file,
          reused: true,
        };
      }
      const reservation = await reserveUploadInTransaction(
        tx,
        userId,
        storageBytes,
      );
      if (!("ok" in reservation)) return reservation;
      const rows = await tx
        .insert(videos)
        .values({
          userId,
          file: fileKey,
          transcriptionLanguage,
          title,
          description,
          status: "uploading",
          uploadUsagePeriodStart: reservation.periodStart,
          sourceType: "uploaded",
          sourceUrl: "",
          youtubeVideoId: "",
          transcript: "",
          errorMessage: "",
          uploadedAt: sql`CURRENT_TIMESTAMP`,
        })
        .returning({ id: videos.id });
      const videoId = Number(rows[0].id);
      await recordIdempotentResource(tx, userId, idempotency, videoId);
      return {
        ok: true as const,
        videoId,
        fileKey,
        reused: false,
      };
    }),
  );
}

export async function getVideoFileKey(
  env: Bindings,
  videoId: number,
  userId: string,
): Promise<{ found: false } | { found: true; fileKey: string | null }> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({ file: videos.file })
      .from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
      .limit(1);
    if (rows.length === 0) return { found: false } as const;
    return { found: true, fileKey: rows[0].file || null };
  });
}

export function createPostgresVideoUploadRepository(env: Bindings): VideoUploadRepository {
 return {
  reserveUpload: p => reserveAndCreatePendingVideo(env,p.userId,p.storageBytes,p.fileKey,p.title,p.description,p.idempotency,p.transcriptionLanguage),
  createYoutube: p => createYoutubeVideo(env,p.userId,p,p.idempotency),
  confirmUpload: p => confirmUploadedVideo(env,p.videoId,p.userId,p.fileKey),
  getUploadState: (videoId,userId) => getVideoUploadState(env,videoId,userId),
 };
}
