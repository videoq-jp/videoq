import {postgresMaterialsLease} from './materials-sync-repository';
import {MaterialsLeaseLostError} from '../contracts/materials-sync-repository';
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { withDb, type Db } from "../../db/pool";
import { teachingConnections, mcpIdempotencyRecords, externalTasks, lmsCourses, lmsInstallations, lmsResources, users, videoCourseMembers, videoCourses, videos } from "../../db/schema";
import { buildPendingUploadFileKey, fileExtension, parseReservedBytesFromFileKey } from "../../lib/upload";
import { reserveUploadInTransaction, refundUnconfirmedUpload } from "./storage-quota";
import { activeLmsOwner } from "./lms-owner-policy";
import { LmsSyncError, type ResourceManifest } from "../../features/lms/resource";
import type { Bindings } from "../../types/bindings";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from '../../lib/job-message';
import { insertJobTask } from './external-task-repository';

import type {LmsGrant,OwnedLmsGrant,LmsResourceReadRepository,LmsResourceSyncRepository} from '../contracts/lms-resource-repository';
import {normalizeLmsResource,normalizeLmsResourceData} from '../../shared/lms-resource-values';

/** Owner first: share the existing account's atomic quota and lock order. */
export async function lockLmsGrant(db: Db, grant: OwnedLmsGrant, contextId?:string, courseId?:number) {
  const [owner] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, grant.ownerUserId), activeLmsOwner())).for("update");
  const [installation] = await db.select({ id: lmsInstallations.id }).from(lmsInstallations)
    .where(and(eq(lmsInstallations.id, grant.id), eq(lmsInstallations.active, true))).for("update");
  const [link]=await db.select({id:teachingConnections.id}).from(teachingConnections).where(and(
    eq(teachingConnections.provider,'moodle'),eq(teachingConnections.installationId,grant.id),eq(teachingConnections.ownerUserId,grant.ownerUserId),
    eq(teachingConnections.active,true),contextId===undefined?undefined:eq(teachingConnections.contextId,contextId),courseId===undefined?undefined:eq(teachingConnections.courseId,courseId))).for('share');
  if (!owner || !installation || !link) throw new LmsSyncError(403, "INSTALLATION_UNAVAILABLE");
  if(grant.materialsLease){
    const proof={...grant.materialsLease,installationId:grant.id};
    const valid=await db.execute(sql`SELECT id FROM lti_credentials WHERE id=${proof.id} AND ${postgresMaterialsLease(proof)} FOR SHARE`);
    if(!valid.rows.length)throw new MaterialsLeaseLostError();
  }
  return owner.id;
}

/** Release media through the same durable outbox as ordinary video deletion. */
async function removeVideo(db: Db, ownerUserId: string, videoId: number, resourceId: string) {
  const [video] = await db.select().from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, ownerUserId))).for("update");
  if (!video) return;
  const shared = await db.execute(sql`SELECT 1 FROM lms_resources WHERE video_id=${videoId} AND id<>${resourceId}
    UNION ALL SELECT 1 FROM video_course_members WHERE video_id=${videoId} LIMIT 1`);
  if (shared.rows.length) throw new LmsSyncError(409, 'SHARED_MATERIAL');
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
  await db.delete(mcpIdempotencyRecords).where(and(eq(mcpIdempotencyRecords.userId,ownerUserId),eq(mcpIdempotencyRecords.resourceId,videoId),sql`${mcpIdempotencyRecords.action} IN ('request_video_upload','create_youtube_video')`));
  await db.delete(videos).where(eq(videos.id, videoId));
}

async function syncLmsResource(env: Bindings, grant: LmsGrant, externalId: string, manifest: ResourceManifest, manifestHash:string) {
  return withDb(env, db => db.transaction(async tx => {
    const [link]=await tx.select().from(teachingConnections).where(and(eq(teachingConnections.provider,'moodle'),eq(teachingConnections.installationId,grant.id),
      eq(teachingConnections.contextId,manifest.contextId),eq(teachingConnections.active,true)));
    if(!link||link.resourceLinkId)throw new LmsSyncError(403,'TEACHER_CONNECTION_REQUIRED');
    if(grant.ownerUserId && grant.ownerUserId!==link.ownerUserId)throw new LmsSyncError(403,'INSTALLATION_UNAVAILABLE');
    const ownerUserId=await lockLmsGrant(tx,{...grant,ownerUserId:link.ownerUserId},manifest.contextId);
    // Re-read the exact link after acquiring the owner/installation locks.
    const [currentLink]=await tx.select().from(teachingConnections).where(and(eq(teachingConnections.id,link.id),eq(teachingConnections.active,true))).for('share');
    if(!currentLink||currentLink.ownerUserId!==ownerUserId||currentLink.courseId!==link.courseId||currentLink.resourceLinkId)throw new LmsSyncError(403,'TEACHER_CONNECTION_REQUIRED');
    const [teacherCourse]=await tx.select({id:lmsCourses.courseId}).from(lmsCourses).where(and(eq(lmsCourses.installationId,grant.id),eq(lmsCourses.contextId,manifest.contextId),eq(lmsCourses.courseId,link.courseId)));
    if(!teacherCourse)throw new LmsSyncError(403,'TEACHER_CONNECTION_REQUIRED');
    const [previous] = await tx.select().from(lmsResources)
      .where(and(eq(lmsResources.installationId, grant.id), eq(lmsResources.externalId, externalId))).for("update");
    if (previous && (previous.kind !== (manifest.kind ?? 'video')
      || previous.kind === 'course' && previous.contextId !== manifest.contextId)) {
      throw new LmsSyncError(409, 'RESOURCE_KIND_OR_CONTEXT_CHANGED');
    }
    if (previous && (manifest.generation < previous.generation ||
        (manifest.generation === previous.generation && manifestHash !== previous.manifestHash))) {
      throw new LmsSyncError(409, "STALE_GENERATION");
    }
    const [ownershipMapping]=await tx.select({id:lmsCourses.id,owner:videoCourses.userId}).from(lmsCourses)
      .leftJoin(videoCourses,eq(videoCourses.id,lmsCourses.courseId)).where(and(eq(lmsCourses.installationId,grant.id),eq(lmsCourses.contextId,manifest.contextId)));
    if(ownershipMapping && ownershipMapping.owner!==ownerUserId)throw new LmsSyncError(409,'COURSE_BINDING_CHANGED');
    if (manifest.kind === 'course') {
      const [mapping] = await tx.select().from(lmsCourses).where(and(
        eq(lmsCourses.installationId, grant.id), eq(lmsCourses.contextId, manifest.contextId)));
      const courseId = mapping?.courseId ?? null;
      if (courseId !== null) {
        const [course] = await tx.select().from(videoCourses).where(eq(videoCourses.id, courseId)).for('update');
        if (!course || course.userId !== ownerUserId || !course.managedByLms || !course.nativeAccessDisabled
          || previous?.courseId != null && previous.courseId !== courseId) throw new LmsSyncError(409, 'COURSE_BINDING_CHANGED');
      }
      if (previous?.generation === manifest.generation && (!manifest.enabled || courseId !== null)) return previous;
      // No media, upload reservation, processing task, or AI usage for an entry.
      if(courseId===null)throw new LmsSyncError(403,'TEACHER_CONNECTION_REQUIRED');
      if(manifest.courseTitle)await tx.update(videoCourses).set({name:manifest.courseTitle,updatedAt:sql`now()`}).where(eq(videoCourses.id,courseId));
      // Entry tombstones revoke this launch; the shared course and its history
      // remain available to privacy processing and other enabled activities.
      const values = { installationId: grant.id, externalId, kind: 'course', contextId: manifest.contextId,
        resourceLinkId: manifest.resourceLinkId, generation: manifest.generation, manifestHash,
        enabled: manifest.enabled, courseId, videoId: null, contentHash: null, contentType: null,
        fileSize: null, syncError: null, updatedAt: sql`now()` };
      const [resource] = previous
        ? await tx.update(lmsResources).set(values).where(eq(lmsResources.id, previous.id)).returning()
        : await tx.insert(lmsResources).values({ id: crypto.randomUUID(), ...values }).returning();
      return resource;
    }
    const [previousVideo] = previous?.videoId ? await tx.select({ status: videos.status, userId: videos.userId,
      sourceType: videos.sourceType, youtubeVideoId: videos.youtubeVideoId, transcriptionLanguage: videos.transcriptionLanguage }).from(videos).where(eq(videos.id, previous.videoId)) : [];
    // Never adopt another account's source. YouTube additionally binds the
    // source kind and identity before provenance repair or an idempotent exit.
    if (previous?.videoId && previousVideo
      && (previousVideo.userId !== ownerUserId || manifest.kind==='youtube' && (previousVideo.sourceType !== 'youtube'
        || previousVideo.youtubeVideoId !== previous.youtubeVideoId))) throw new LmsSyncError(409, 'RESOURCE_BINDING_CHANGED');
    // Idempotent reconciliation also repairs provenance left by older writers.
    if (previous?.videoId) await tx.update(videos).set({ managedByLms: true }).where(and(
      eq(videos.id, previous.videoId), eq(videos.userId, ownerUserId), eq(videos.managedByLms, false)));
    if (previous?.courseId) await tx.update(videoCourses).set({ managedByLms: true, nativeAccessDisabled: true }).where(and(
      eq(videoCourses.id, previous.courseId), eq(videoCourses.userId, ownerUserId),
      sql`(${videoCourses.managedByLms}=false OR ${videoCourses.nativeAccessDisabled}=false)`));
    if (previous?.generation === manifest.generation && (!manifest.enabled || previous.videoId !== null)) return previous;
    const keepVideo = !manifest.deleted && previous?.videoId != null && previousVideo?.status !== "error"
      && (manifest.kind === 'youtube'
        ? previousVideo?.userId === ownerUserId && previousVideo.sourceType === 'youtube'
          && previous.youtubeVideoId === (manifest.youtubeVideoId ?? previous.youtubeVideoId)
          && previousVideo.youtubeVideoId === previous.youtubeVideoId
        : previous.contentHash === (manifest.file?.contentHash ?? previous.contentHash)
          && previous.fileSize === (manifest.file?.size ?? previous.fileSize)
          && previous.contentType === (manifest.file?.contentType ?? previous.contentType));
    // Language is an upload-time processing option. Existing material must not
    // be silently reprocessed or lose its history when only this option changes.
    if (manifest.enabled && keepVideo && manifest.transcriptionLanguage !== undefined
      && previousVideo?.transcriptionLanguage !== manifest.transcriptionLanguage) {
      throw new LmsSyncError(409, 'TRANSCRIPTION_LANGUAGE_LOCKED');
    }
    let videoId = keepVideo ? previous.videoId : null;
    let syncError: string | null = null;
    const [mapping] = await tx.select().from(lmsCourses).where(and(eq(lmsCourses.installationId, grant.id), eq(lmsCourses.contextId, manifest.contextId)));
    const [courseEntry] = await tx.select({ id: lmsResources.id }).from(lmsResources).where(and(
      eq(lmsResources.installationId, grant.id), eq(lmsResources.contextId, manifest.contextId), eq(lmsResources.kind, 'course'))).limit(1);
    const courseId: number | null = mapping?.courseId ?? null;
    // Removing membership revokes questions immediately, before any processing.
    if (previous?.courseId && previous.videoId && previous.contextId !== manifest.contextId) {
      // Course vocabulary must not travel with a source moved to another course.
      // Ordinary resync and temporary disable keep the same course's assignments.
      await tx.execute(sql`DELETE FROM lti_course_video_tags a USING lti_course_tags t
        WHERE a.tag_id=t.id AND t.course_id=${previous.courseId} AND a.video_id=${previous.videoId}`);
    }
    if (previous?.courseId && previous.videoId) await tx.delete(videoCourseMembers).where(and(
      eq(videoCourseMembers.courseId, previous.courseId), eq(videoCourseMembers.videoId, previous.videoId)));
    if (!keepVideo && previous?.videoId) await removeVideo(tx, ownerUserId, previous.videoId, previous.id);
    if (manifest.enabled) {
      if (!keepVideo) {
        if (manifest.kind === 'youtube') {
          const [video] = await tx.insert(videos).values({ managedByLms: true, userId: ownerUserId,
            title: manifest.title, description: '', transcript: '', errorMessage: '', file: '', status: 'pending',
            sourceType: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=' + manifest.youtubeVideoId!,
            youtubeVideoId: manifest.youtubeVideoId!, uploadedAt: sql`now()` }).returning({ id: videos.id });
          videoId = video.id;
          // Same durable job/worker processing-duration quota path as native
          // YouTube transcripts; no source file is uploaded or reserved here.
          await insertJobTask(tx, { message: buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: videoId }) });
        } else {
          const file = manifest.file!;
          const reservation = await reserveUploadInTransaction(tx, ownerUserId, file.size);
          if (!("ok" in reservation)) {
            syncError = "monthlyUploadExceeded" in reservation ? "MONTHLY_UPLOAD_LIMIT_EXCEEDED" : "STORAGE_LIMIT_EXCEEDED";
          } else {
            const [video] = await tx.insert(videos).values({
              managedByLms: true,
              userId: ownerUserId, title: manifest.title, description: "", transcript: "", errorMessage: "",
              file: buildPendingUploadFileKey(ownerUserId, file.size, fileExtension(file.filename)),
              status: "uploading", sourceType: "uploaded", sourceUrl: "", youtubeVideoId: "",
              transcriptionLanguage: manifest.transcriptionLanguage ?? null,
              uploadedAt: sql`now()`, uploadUsagePeriodStart: reservation.periodStart,
            }).returning({ id: videos.id });
            videoId = video.id;
          }
        }
      } else {
        await tx.update(videos).set({ title: manifest.title, managedByLms: true }).where(eq(videos.id, videoId!));
      }
      if (videoId !== null) {
        if(!courseId)throw new LmsSyncError(403,'TEACHER_CONNECTION_REQUIRED');
        await tx.update(videoCourses).set({managedByLms:true,nativeAccessDisabled:true,
          ...(!courseEntry&&manifest.courseTitle?{name:manifest.courseTitle}:{}),updatedAt:sql`now()`}).where(eq(videoCourses.id,courseId));
        await tx.insert(videoCourseMembers).values({ courseId, videoId, order: 0, addedAt: sql`now()` });
      }
    }
    const values = {
      installationId: grant.id, externalId, kind: manifest.kind ?? 'video', contextId: manifest.contextId, resourceLinkId: manifest.resourceLinkId,
      generation: manifest.generation, manifestHash, enabled: manifest.enabled,
      contentHash: manifest.deleted ? null : manifest.file?.contentHash ?? previous?.contentHash ?? null,
      contentType: manifest.deleted ? null : manifest.file?.contentType ?? previous?.contentType ?? null,
      fileSize: manifest.deleted ? null : manifest.file?.size ?? previous?.fileSize ?? null, courseId, videoId, syncError, updatedAt: sql`now()`,
      youtubeVideoId: manifest.kind === 'youtube' ? manifest.youtubeVideoId ?? previous?.youtubeVideoId ?? null : null,
    };
    const [resource] = previous
      ? await tx.update(lmsResources).set(values).where(eq(lmsResources.id, previous.id)).returning()
      : await tx.insert(lmsResources).values({ id: crypto.randomUUID(), ...values }).returning();
    return resource;
  }));
}

export function getLmsResource(env: Bindings, grant: LmsGrant, externalId: string) {
  return withDb(env, async db => {
    const [resource] = await db.select({ resource: lmsResources, video: videos, ownerUserId: teachingConnections.ownerUserId })
      .from(lmsResources).innerJoin(lmsInstallations, eq(lmsInstallations.id, lmsResources.installationId))
      .innerJoin(teachingConnections,and(eq(teachingConnections.provider,'moodle'),eq(teachingConnections.installationId,lmsInstallations.id),
        eq(teachingConnections.contextId,lmsResources.contextId),eq(teachingConnections.courseId,lmsResources.courseId),eq(teachingConnections.active,true)))
      .innerJoin(videoCourses,and(eq(videoCourses.id,teachingConnections.courseId),eq(videoCourses.userId,teachingConnections.ownerUserId)))
      .innerJoin(users,eq(users.id,teachingConnections.ownerUserId))
      .leftJoin(videos,and(eq(videos.id,lmsResources.videoId),eq(videos.userId,teachingConnections.ownerUserId)))
      .where(and(eq(lmsResources.installationId, grant.id), eq(lmsResources.externalId, externalId),
        grant.ownerUserId?eq(teachingConnections.ownerUserId,grant.ownerUserId):undefined, eq(lmsInstallations.active, true), activeLmsOwner())).limit(1);
    return resource ?? null;
  });
}

export function createPostgresLmsResourceReadRepository(env:Bindings):LmsResourceReadRepository {
 return {async get(grant,externalId){const data=await getLmsResource(env,grant,externalId);return data?normalizeLmsResourceData(data):null;}};
}

export function createPostgresLmsResourceSyncRepository(env:Bindings):LmsResourceSyncRepository {
 return {async sync(...args){return normalizeLmsResource(await syncLmsResource(env,...args));}};
}
