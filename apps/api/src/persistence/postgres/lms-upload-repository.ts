import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withDb, type Db } from "../../db/pool";
import { insertSelectValues } from "../../db/postgres/query-builders";
import {
  users,
  lmsInstallations,
  lmsResources,
  teachingConnections,
  videoCourses,
  videos,
  externalTasks,
  ltiCredentials,
} from "../../db/schema";
import { activeLmsOwner } from "./lms-owner-policy";
import type { Bindings } from "../../types/bindings";
import type {
  LmsUploadRepository,
  LmsUploadSnapshot,
} from "../contracts/lms-upload-repository";
import type { OwnedLmsGrant } from "../contracts/lms-resource-repository";
import {
  contentSlot,
  contentCleanup,
  contentPayload,
  checkContentAttempt,
} from "../../shared/lms-upload";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";

function source(db: Db, grant: OwnedLmsGrant, snapshot: LmsUploadSnapshot) {
  return db
    .select({ id: videos.id, status: videos.status })
    .from(lmsResources)
    .innerJoin(videos, eq(videos.id, lmsResources.videoId))
    .innerJoin(
      lmsInstallations,
      eq(lmsInstallations.id, lmsResources.installationId),
    )
    .innerJoin(
      teachingConnections,
      and(
        eq(teachingConnections.provider, "moodle"),
        eq(teachingConnections.installationId, lmsInstallations.id),
        eq(teachingConnections.contextId, lmsResources.contextId),
        eq(teachingConnections.courseId, lmsResources.courseId),
        eq(teachingConnections.active, true),
        isNull(teachingConnections.resourceLinkId),
      ),
    )
    .innerJoin(
      videoCourses,
      and(
        eq(videoCourses.id, teachingConnections.courseId),
        eq(videoCourses.userId, teachingConnections.ownerUserId),
      ),
    )
    .innerJoin(users, eq(users.id, teachingConnections.ownerUserId))
    .where(
      and(
        eq(lmsInstallations.id, grant.id),
        eq(users.id, grant.ownerUserId),
        eq(lmsResources.id, snapshot.resourceId),
        eq(lmsResources.externalId, snapshot.externalId),
        eq(lmsResources.generation, snapshot.generation),
        eq(videos.id, snapshot.videoId),
        eq(videos.file, snapshot.fileKey),
        eq(lmsResources.fileSize, snapshot.size),
        eq(lmsResources.contentType, snapshot.contentType),
        eq(lmsResources.enabled, true),
        eq(lmsResources.kind, "video"),
        eq(videos.userId, users.id),
        eq(videos.managedByLms, true),
        eq(videos.sourceType, "uploaded"),
        eq(lmsInstallations.active, true),
        activeLmsOwner(sql`clock_timestamp()`),
      ),
    )
    .for("update", { of: [lmsResources, videos] });
}
const slotMatches = (slot: string, payload: string) =>
  and(
    eq(ltiCredentials.id, slot),
    eq(ltiCredentials.kind, "lms-content-upload"),
    sql`${ltiCredentials.payload}=${payload}::jsonb`,
    sql`${ltiCredentials.expiresAt}>clock_timestamp()`,
  );
export function createPostgresLmsUploadRepository(
  env: Bindings,
): LmsUploadRepository {
  function write<T>(
    grant: OwnedLmsGrant,
    operation: (db: Db) => Promise<T>,
  ): Promise<T> {
    return withDb(env, (db) =>
      db.transaction(async (tx) => {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, grant.ownerUserId))
          .for("update");
        await tx
          .select({ id: lmsInstallations.id })
          .from(lmsInstallations)
          .where(eq(lmsInstallations.id, grant.id))
          .for("update");
        return operation(tx);
      }),
    );
  }
  return {
    async prepare(a) {
      checkContentAttempt(a);
      return write(a.grant, async (db) => {
        const [current] = await source(db, a.grant, a.snapshot);
        if (current?.status !== "uploading") return false;
        const slot = contentSlot(a.snapshot),
          payload = contentPayload(a);
        const prior = await db
          .select({ id: externalTasks.id })
          .from(externalTasks)
          .where(eq(externalTasks.dedupeKey, contentCleanup(a.id)));
        if (
          prior.length &&
          !(
            await db
              .select({ id: ltiCredentials.id })
              .from(ltiCredentials)
              .where(slotMatches(slot, payload))
          ).length
        )
          return false;
        await db
          .insert(ltiCredentials)
          .values({
            id: slot,
            kind: "lms-content-upload",
            payload: sql`${payload}::jsonb`,
            expiresAt: sql`clock_timestamp()+interval '15 minutes'`,
          })
          .onConflictDoUpdate({
            target: ltiCredentials.id,
            set: {
              payload: sql`excluded.payload`,
              expiresAt: sql`excluded.expires_at`,
            },
            setWhere: and(
              eq(ltiCredentials.kind, "lms-content-upload"),
              sql`${ltiCredentials.expiresAt}<=clock_timestamp()`,
            ),
          });
        if (
          !(
            await db
              .select({ id: ltiCredentials.id })
              .from(ltiCredentials)
              .where(slotMatches(slot, payload))
          ).length
        )
          return false;
        await db
          .insert(externalTasks)
          .values({
            kind: "storage_cleanup",
            payload: {
              file_key: a.fileKey,
              user_id: a.grant.ownerUserId,
              bytes: 0,
            },
            dedupeKey: contentCleanup(a.id),
            availableAt: sql`clock_timestamp()+interval '2 hours'`,
          })
          .onConflictDoNothing({ target: externalTasks.dedupeKey });
        return true;
      });
    },
    async adopt(a) {
      checkContentAttempt(a);
      return write(a.grant, async (db) => {
        const [current] = await source(db, a.grant, a.snapshot);
        if (current?.status !== "uploading") return false;
        const slot = contentSlot(a.snapshot),
          payload = contentPayload(a);
        if (
          !(
            await db
              .select({ id: ltiCredentials.id })
              .from(ltiCredentials)
              .where(slotMatches(slot, payload))
              .for("update")
          ).length
        )
          return false;
        const task = await db
          .select({ id: externalTasks.id })
          .from(externalTasks)
          .where(
            and(
              eq(externalTasks.dedupeKey, contentCleanup(a.id)),
              eq(externalTasks.kind, "storage_cleanup"),
              sql`${externalTasks.payload}->>'file_key'=${a.fileKey}`,
              eq(externalTasks.attempts, 0),
              isNull(externalTasks.lockedAt),
              isNull(externalTasks.completedAt),
              isNull(externalTasks.deadAt),
              sql`${externalTasks.availableAt}>clock_timestamp()`,
            ),
          )
          .for("update");
        if (!task.length) return false;
        // Recheck the current clock after waiting on the cleanup-row lock.
        if (
          !(
            await db
              .select({ id: ltiCredentials.id })
              .from(ltiCredentials)
              .where(
                and(
                  eq(ltiCredentials.id, slot),
                  sql`${ltiCredentials.expiresAt}>clock_timestamp()`,
                ),
              )
          ).length
        )
          return false;
        await db
          .update(videos)
          .set({ file: a.fileKey, uploadHeartbeatAt: sql`clock_timestamp()` })
          .where(eq(videos.id, a.snapshot.videoId));
        await db
          .update(externalTasks)
          .set({
            payload: sql`jsonb_set(${externalTasks.payload},'{file_key}',to_jsonb(${a.snapshot.fileKey}::text))`,
          })
          .where(eq(externalTasks.dedupeKey, contentCleanup(a.id)));
        await db.delete(ltiCredentials).where(eq(ltiCredentials.id, slot));
        return true;
      });
    },
    async abandon(a) {
      checkContentAttempt(a);
      await write(a.grant, async (db) => {
        const original = alias(externalTasks, "original_cleanup");
        await db
          .insert(externalTasks)
          .select(
            db
              .select(
                insertSelectValues(externalTasks, {
                  kind: "storage_cleanup",
                  payload: {
                    file_key: a.fileKey,
                    user_id: a.grant.ownerUserId,
                    bytes: 0,
                  },
                  dedupeKey: "lms-content-abandon:" + a.id,
                }),
              )
              .from(original)
              .where(
                and(
                  eq(original.dedupeKey, contentCleanup(a.id)),
                  eq(original.kind, "storage_cleanup"),
                  sql`${original.payload}->>'file_key'=${a.fileKey}`,
                  notExists(
                    db
                      .select({ id: videos.id })
                      .from(videos)
                      .where(eq(videos.file, a.fileKey)),
                  ),
                ),
              ),
          )
          .onConflictDoNothing({ target: externalTasks.dedupeKey });
        await db
          .delete(ltiCredentials)
          .where(
            and(
              eq(ltiCredentials.id, contentSlot(a.snapshot)),
              eq(ltiCredentials.kind, "lms-content-upload"),
              sql`${ltiCredentials.payload}=${contentPayload(a)}::jsonb`,
            ),
          );
      });
    },
    confirm: (grant, snapshot, objectVerified) =>
      write(grant, async (db) => {
        const [current] = await source(db, grant, snapshot);
        if (!current) return { status: "stale" };
        if (current.status !== "uploading")
          return [
            "pending",
            "processing",
            "indexing",
            "completed",
            "error",
          ].includes(current.status)
            ? { status: "already" }
            : { status: "stale" };
        if (!objectVerified) return { status: "stale" };
        const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, {
          video_id: snapshot.videoId,
        });
        await db
          .update(videos)
          .set({ status: "pending", errorMessage: "" })
          .where(eq(videos.id, snapshot.videoId));
        const [task] = await db
          .insert(externalTasks)
          .values({
            kind: "sqs_job",
            payload: { message },
            dedupeKey: "job:" + message.job_id,
          })
          .returning({ id: externalTasks.id });
        return {
          status: "queued",
          job: {
            videoId: snapshot.videoId,
            taskId: Number(task.id),
            jobId: message.job_id,
          },
        };
      }),
  };
}
