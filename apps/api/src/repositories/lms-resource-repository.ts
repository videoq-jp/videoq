import { and, eq, isNotNull, sql } from "drizzle-orm";
import { withDb, type Db } from "../db/pool";
import { externalTasks, lmsCourses, lmsInstallations, lmsResources, users, videoCourseMembers, videoCourses, videos } from "../db/schema";
import { buildPendingUploadFileKey, fileExtension, parseReservedBytesFromFileKey } from "../lib/upload";
import { reserveUploadInTransaction, refundUnconfirmedUpload } from "./quota-repository";
import { activeLmsOwner } from "./lms-installation-repository";
import { digest } from "../features/lti/store";
import { LmsSyncError, type ResourceManifest } from "../features/lms/resource";
import type { Bindings } from "../types/bindings";

export type LmsGrant = { id: string; ownerUserId: string };

/** Owner first: share the existing account's atomic quota and lock order. */
export async function lockLmsGrant(db: Db, grant: LmsGrant) {
  const [owner] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, grant.ownerUserId), activeLmsOwner())).for("update");
  const [installation] = await db.select({ id: lmsInstallations.id }).from(lmsInstallations)
    .where(and(eq(lmsInstallations.id, grant.id), eq(lmsInstallations.ownerUserId, grant.ownerUserId), eq(lmsInstallations.active, true))).for("update");
  if (!owner || !installation) throw new LmsSyncError(403, "INSTALLATION_UNAVAILABLE");
  return owner.id;
}

/** Release media through the same durable outbox as ordinary video deletion. */
async function removeVideo(db: Db, ownerUserId: string, videoId: number) {
  const [video] = await db.select().from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, ownerUserId))).for("update");
  if (!video) return;
  const bytes = parseReservedBytesFromFileKey(video.file);
  await db.insert(externalTasks).values({
    kind: "storage_cleanup", dedupeKey: `storage:video:${videoId}`,
    payload: { file_key: video.file, user_id: ownerUserId, bytes },
  }).onConflictDoNothing();
  if (video.status === "uploading") {
    const [service] = await db.select({ id: lmsInstallations.id }).from(lmsResources)
      .innerJoin(lmsInstallations, eq(lmsInstallations.id, lmsResources.installationId))
      .where(and(eq(lmsResources.videoId, videoId), isNotNull(lmsInstallations.materialsService))).limit(1);
    if (service) await db.insert(externalTasks).values({ kind: "storage_cleanup",
      dedupeKey: `storage:video:${videoId}:late-upload`,
      // A PUT already in flight can finish after immediate deletion. Retry after
      // the signed URL and maximum platform transfer window have both expired.
      availableAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      payload: { file_key: video.file, user_id: ownerUserId, bytes: null },
    }).onConflictDoNothing();
  }
  if (video.status === "uploading" && video.uploadUsagePeriodStart && bytes) {
    await refundUnconfirmedUpload(db, ownerUserId, bytes, video.uploadUsagePeriodStart);
  }
  await db.execute(sql`DELETE FROM scene_embeddings WHERE video_id = ${videoId}`);
  await db.delete(videos).where(eq(videos.id, videoId));
}

export async function syncLmsResource(env: Bindings, grant: LmsGrant, externalId: string, manifest: ResourceManifest) {
  const manifestHash = await digest(JSON.stringify(manifest));
  return withDb(env, db => db.transaction(async tx => {
    const ownerUserId = await lockLmsGrant(tx, grant);
    const [previous] = await tx.select().from(lmsResources)
      .where(and(eq(lmsResources.installationId, grant.id), eq(lmsResources.externalId, externalId))).for("update");
    if (previous && (manifest.generation < previous.generation ||
        (manifest.generation === previous.generation && manifestHash !== previous.manifestHash))) {
      throw new LmsSyncError(409, "STALE_GENERATION");
    }
    if (previous?.generation === manifest.generation && (!manifest.enabled || previous.videoId !== null)) return previous;
    const [previousVideo] = previous?.videoId ? await tx.select({ status: videos.status }).from(videos).where(eq(videos.id, previous.videoId)) : [];
    const keepVideo = !manifest.deleted && previous?.videoId != null && previousVideo?.status !== "error"
      && previous.contentHash === (manifest.file?.contentHash ?? previous.contentHash)
      && previous.fileSize === (manifest.file?.size ?? previous.fileSize)
      && previous.contentType === (manifest.file?.contentType ?? previous.contentType);
    let videoId = keepVideo ? previous.videoId : null;
    let syncError: string | null = null;
    const [mapping] = await tx.select().from(lmsCourses).where(and(eq(lmsCourses.installationId, grant.id), eq(lmsCourses.contextId, manifest.contextId)));
    let courseId: number | null = mapping?.courseId ?? null;
    // Removing membership revokes questions immediately, before any processing.
    if (previous?.courseId && previous.videoId) await tx.delete(videoCourseMembers).where(and(
      eq(videoCourseMembers.courseId, previous.courseId), eq(videoCourseMembers.videoId, previous.videoId)));
    if (!keepVideo && previous?.videoId) await removeVideo(tx, ownerUserId, previous.videoId);
    if (manifest.enabled) {
      const file = manifest.file!;
      if (!keepVideo) {
        const reservation = await reserveUploadInTransaction(tx, ownerUserId, file.size);
        if (!("ok" in reservation)) {
          syncError = "monthlyUploadExceeded" in reservation ? "MONTHLY_UPLOAD_LIMIT_EXCEEDED" : "STORAGE_LIMIT_EXCEEDED";
        } else {
          const [video] = await tx.insert(videos).values({
            userId: ownerUserId, title: manifest.title, description: "", transcript: "", errorMessage: "",
            file: buildPendingUploadFileKey(ownerUserId, file.size, fileExtension(file.filename)),
            status: "uploading", sourceType: "uploaded", sourceUrl: "", youtubeVideoId: "",
            uploadedAt: sql`now()`, uploadUsagePeriodStart: reservation.periodStart,
          }).returning({ id: videos.id });
          videoId = video.id;
        }
      } else {
        await tx.update(videos).set({ title: manifest.title }).where(eq(videos.id, videoId!));
      }
      if (videoId !== null) {
        if (!courseId) {
          const [course] = await tx.insert(videoCourses).values({
            userId: ownerUserId, name: manifest.courseTitle ?? "Moodle " + manifest.contextId, description: "", displayOrder: 0,
            createdAt: sql`now()`, updatedAt: sql`now()`,
          }).returning({ id: videoCourses.id });
          courseId = course.id;
          await tx.insert(lmsCourses).values({ id: crypto.randomUUID(), installationId: grant.id, contextId: manifest.contextId, courseId });
        } else if (manifest.courseTitle) {
          await tx.update(videoCourses).set({ name: manifest.courseTitle, updatedAt: sql`now()` }).where(eq(videoCourses.id, courseId));
        }
        await tx.insert(videoCourseMembers).values({ courseId, videoId, order: 0, addedAt: sql`now()` });
      }
    }
    const values = {
      installationId: grant.id, externalId, contextId: manifest.contextId, resourceLinkId: manifest.resourceLinkId,
      generation: manifest.generation, manifestHash, enabled: manifest.enabled,
      contentHash: manifest.deleted ? null : manifest.file?.contentHash ?? previous?.contentHash ?? null,
      contentType: manifest.deleted ? null : manifest.file?.contentType ?? previous?.contentType ?? null,
      fileSize: manifest.deleted ? null : manifest.file?.size ?? previous?.fileSize ?? null, courseId, videoId, syncError, updatedAt: sql`now()`,
    };
    const [resource] = previous
      ? await tx.update(lmsResources).set(values).where(eq(lmsResources.id, previous.id)).returning()
      : await tx.insert(lmsResources).values({ id: crypto.randomUUID(), ...values }).returning();
    return resource;
  }));
}

export function getLmsResource(env: Bindings, grant: LmsGrant, externalId: string) {
  return withDb(env, async db => {
    const [resource] = await db.select({ resource: lmsResources, video: videos, ownerUserId: lmsInstallations.ownerUserId })
      .from(lmsResources).innerJoin(lmsInstallations, eq(lmsInstallations.id, lmsResources.installationId))
      .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
      .leftJoin(videos, eq(videos.id, lmsResources.videoId))
      .where(and(eq(lmsResources.installationId, grant.id), eq(lmsResources.externalId, externalId),
        eq(lmsInstallations.ownerUserId, grant.ownerUserId), eq(lmsInstallations.active, true), activeLmsOwner())).limit(1);
    return resource ?? null;
  });
}
