import { and, or, eq, exists, notExists, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectFields,
  insertSelectValues,
  runD1Batch,
} from "../../db/d1/query-builders";
import {
  lmsResources as resources,
  videos,
  lmsInstallations as installations,
  teachingConnections as connections,
  videoCourses,
  users,
  ltiCredentials as credentials,
  externalTasks as tasks,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import { activeD1LmsOwner } from "./lms-owner-policy";
import type {
  LmsUploadRepository,
  LmsUploadSnapshot,
  LmsContentAttempt,
} from "../contracts/lms-upload-repository";
import type { OwnedLmsGrant } from "../contracts/lms-resource-repository";
import {
  contentSlot,
  contentCleanup,
  contentPayload,
  checkContentAttempt,
} from "../../shared/lms-upload";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";
export function createD1LmsUploadRepository(
  database: D1Database,
): LmsUploadRepository {
  const db = createD1Connection(database);
  const source = (g: OwnedLmsGrant, s: LmsUploadSnapshot, uploading = false) =>
    db
      .select({ id: videos.id, status: videos.status })
      .from(resources)
      .innerJoin(videos, eq(videos.id, resources.videoId))
      .innerJoin(installations, eq(installations.id, resources.installationId))
      .innerJoin(
        connections,
        and(
          eq(connections.provider, "moodle"),
          eq(connections.installationId, installations.id),
          eq(connections.contextId, resources.contextId),
          eq(connections.courseId, resources.courseId),
          eq(connections.active, true),
          isNull(connections.resourceLinkId),
        ),
      )
      .innerJoin(
        videoCourses,
        and(
          eq(videoCourses.id, connections.courseId),
          eq(videoCourses.userId, connections.ownerUserId),
        ),
      )
      .innerJoin(users, eq(users.id, connections.ownerUserId))
      .where(
        and(
          eq(installations.id, g.id),
          eq(users.id, g.ownerUserId),
          eq(resources.id, s.resourceId),
          eq(resources.externalId, s.externalId),
          eq(resources.generation, s.generation),
          eq(videos.id, s.videoId),
          eq(videos.file, s.fileKey),
          eq(resources.fileSize, s.size),
          eq(resources.contentType, s.contentType),
          eq(resources.enabled, true),
          eq(resources.kind, "video"),
          eq(videos.userId, users.id),
          eq(videos.managedByLms, true),
          eq(videos.sourceType, "uploaded"),
          eq(installations.active, true),
          activeD1LmsOwner(),
          uploading ? eq(videos.status, "uploading") : undefined,
        ),
      )
      .limit(1);
  const live = (a: LmsContentAttempt) =>
    exists(
      db
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.id, contentSlot(a.snapshot)),
            eq(credentials.kind, "lms-content-upload"),
            sql`json(${credentials.payload})=json(${contentPayload(a)})`,
            sql`julianday(${credentials.expiresAt})>julianday('now')`,
          ),
        ),
    );
  const gate = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  return {
    async prepare(a) {
      checkContentAttempt(a);
      const payload = contentPayload(a),
        slot = contentSlot(a.snapshot);
      const result = await runD1Batch(database, [
        db
          .insert(credentials)
          .select(
            db
              .select(
                insertSelectFields(credentials, {
                  id: sql`${slot}`,
                  kind: sql`'lms-content-upload'`,
                  payload: sql`${payload}`,
                  expiresAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes')`,
                }),
              )
              .from(source(a.grant, a.snapshot, true).as("source"))
              .where(
                or(
                  notExists(
                    db
                      .select({ id: tasks.id })
                      .from(tasks)
                      .where(eq(tasks.dedupeKey, contentCleanup(a.id))),
                  ),
                  live(a),
                ),
              ),
          )
          .onConflictDoUpdate({
            target: credentials.id,
            set: {
              payload: sql`excluded.payload`,
              expiresAt: sql`excluded.expires_at`,
            },
            setWhere: and(
              eq(credentials.kind, "lms-content-upload"),
              sql`julianday(${credentials.expiresAt})<=julianday('now')`,
            ),
          }),
        db
          .insert(tasks)
          .select(
            db
              .select(
                insertSelectValues(tasks, {
                  kind: "storage_cleanup",
                  payload: {
                    file_key: a.fileKey,
                    user_id: a.grant.ownerUserId,
                    bytes: 0,
                  },
                  dedupeKey: contentCleanup(a.id),
                  availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours')`,
                }),
              )
              .from(credentials)
              .where(and(eq(credentials.id, slot), live(a))),
          )
          .onConflictDoNothing({ target: tasks.dedupeKey }),
        db
          .select({ id: credentials.id })
          .from(credentials)
          .where(
            and(
              eq(credentials.id, slot),
              eq(credentials.kind, "lms-content-upload"),
              sql`json(${credentials.payload})=json(${payload})`,
              exists(source(a.grant, a.snapshot, true)),
            ),
          ),
      ]);
      return result[2].results.length > 0;
    },
    async adopt(a) {
      checkContentAttempt(a);
      const token = crypto.randomUUID(),
        slot = contentSlot(a.snapshot),
        payload = contentPayload(a);
      const cleanup = exists(
        db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.dedupeKey, contentCleanup(a.id)),
              eq(tasks.kind, "storage_cleanup"),
              eq(sql`json_extract(${tasks.payload},'$.file_key')`, a.fileKey),
              eq(tasks.attempts, 0),
              isNull(tasks.lockedAt),
              isNull(tasks.completedAt),
              isNull(tasks.deadAt),
              sql`julianday(${tasks.availableAt})>julianday('now')`,
            ),
          ),
      );
      const result = await runD1Batch(database, [
        db.insert(receipts).select(
          db
            .select(
              insertSelectValues(receipts, {
                token,
                kind: "lms_content_adopt",
                resourceId: a.snapshot.videoId,
              }),
            )
            .from(source(a.grant, a.snapshot, true).as("source"))
            .where(and(live(a), cleanup)),
        ),
        db
          .update(videos)
          .set({
            file: a.fileKey,
            uploadHeartbeatAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          })
          .where(and(eq(videos.id, a.snapshot.videoId), gate(token))),
        // Once canonical, the delayed cleanup retires the former file key instead.
        db
          .update(tasks)
          .set({
            payload: sql`json_set(${tasks.payload},'$.file_key',${a.snapshot.fileKey})`,
          })
          .where(and(eq(tasks.dedupeKey, contentCleanup(a.id)), gate(token))),
        db
          .delete(credentials)
          .where(
            and(
              eq(credentials.id, slot),
              sql`json(${credentials.payload})=json(${payload})`,
              gate(token),
            ),
          ),
        db
          .select({ token: receipts.token })
          .from(receipts)
          .where(eq(receipts.token, token)),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      return result[4].results.length > 0;
    },
    async abandon(a) {
      checkContentAttempt(a);
      const original = alias(tasks, "original_cleanup");
      await runD1Batch(database, [
        db
          .insert(tasks)
          .select(
            db
              .select(
                insertSelectValues(tasks, {
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
                  eq(
                    sql`json_extract(${original.payload},'$.file_key')`,
                    a.fileKey,
                  ),
                  notExists(
                    db
                      .select({ id: videos.id })
                      .from(videos)
                      .where(eq(videos.file, a.fileKey)),
                  ),
                ),
              ),
          )
          .onConflictDoNothing({ target: tasks.dedupeKey }),
        db
          .delete(credentials)
          .where(
            and(
              eq(credentials.id, contentSlot(a.snapshot)),
              eq(credentials.kind, "lms-content-upload"),
              sql`json(${credentials.payload})=json(${contentPayload(a)})`,
            ),
          ),
      ]);
    },
    async confirm(grant, snapshot, objectVerified) {
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, {
          video_id: snapshot.videoId,
        }),
        dedupe = "job:" + message.job_id;
      const result = await runD1Batch<{ id: number; status: string }>(
        database,
        [
          db.insert(tasks).select(
            db
              .select(
                insertSelectValues(tasks, {
                  kind: "sqs_job",
                  payload: { message },
                  dedupeKey: dedupe,
                }),
              )
              .from(source(grant, snapshot, true).as("source"))
              .where(sql`${Number(objectVerified)}=1`),
          ),
          db
            .update(videos)
            .set({ status: "pending", errorMessage: "" })
            .where(and(eq(videos.id, snapshot.videoId), sql`changes()=1`)),
          db
            .select({ id: tasks.id })
            .from(tasks)
            .where(eq(tasks.dedupeKey, dedupe)),
          source(grant, snapshot),
        ],
      );
      const task = result[2].results[0];
      if (task)
        return {
          status: "queued",
          job: {
            videoId: snapshot.videoId,
            taskId: Number(task.id),
            jobId: message.job_id,
          },
        };
      const status = result[3].results[0]?.status;
      return typeof status === "string" &&
        ["pending", "processing", "indexing", "completed", "error"].includes(
          status,
        )
        ? { status: "already" }
        : { status: "stale" };
    },
  };
}
