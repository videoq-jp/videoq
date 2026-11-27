import { and, eq, notExists, isNull, isNotNull, or, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectValues, runD1Batch } from "../../db/d1/query-builders";
import { videos, externalTasks } from "../../db/schema/sqlite";
import {
  uploadConfirmed,
  assertMultipartInitialization,
  activeMultipartSession,
  multipartReservation,
  multipartPartLength,
  orderedMultipartParts,
  multipartObjectMatches,
  assertMultipartObjectSize,
} from "../../domain/media/multipart-upload";
import { multipartPartSize } from "@videoq/domain/video-upload";
import {
  UploadSessionError,
  type MultipartUploadRepository,
} from "../contracts/multipart-upload-repository";
import {
  createR2MultipartUpload,
  completeR2MultipartUpload,
  getR2ObjectSize,
  presignR2UploadPart,
} from "../../integrations/media";
import { parseReservedBytesFromFileKey } from "../../domain/media/upload";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";
import { armMaintenance } from "../../lib/task-scheduler";
import { sha256Hex } from "../../shared/crypto";
import type { Bindings } from "../../types/bindings";
type Session = { uploadId: string; contentType: string; partSize: number };
type Video = { file: string; status: string; multipart_upload: string | null };
const NOW = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
export function createD1MultipartUploadRepository(
  database: D1Database,
  env: Bindings,
): MultipartUploadRepository {
  const db = createD1Connection(database);
  const read = async (id: number, user: string) => {
    const row = await db
      .select({
        file: videos.file,
        status: videos.status,
        multipart_upload: sql<string | null>`${videos.multipartUpload}`,
      })
      .from(videos)
      .where(and(eq(videos.id, id), eq(videos.userId, user)))
      .get();
    if (!row) throw new UploadSessionError("Video not found", "NOT_FOUND");
    return row;
  };
  const matches = (id: number, user: string, v: Video) =>
    and(
      eq(videos.id, id),
      eq(videos.userId, user),
      eq(videos.file, v.file),
      eq(videos.status, "uploading"),
      sql`json(${videos.multipartUpload}) IS json(${v.multipart_upload})`,
    );
  const active = (v: Video) =>
    JSON.parse(activeMultipartSession(v.status, v.multipart_upload)) as Session;
  const sizeOf = (v: Video) =>
    multipartReservation(parseReservedBytesFromFileKey(v.file));
  const cleanupKey = async (file: string, uploadId: string) =>
    "multipart-abort:" + (await sha256Hex(JSON.stringify([file, uploadId])));
  const abandon = async (file: string, user: string, uploadId: string) => {
    const key = await cleanupKey(file, uploadId);
    await db
      .insert(externalTasks)
      .select(
        db
          .select(
            insertSelectValues(externalTasks, {
              kind: "multipart_abort",
              payload: {
                file_key: file,
                user_id: user,
                bytes: 0,
                multipart_upload_id: uploadId,
              },
              dedupeKey: key,
            }),
          )
          .from(sql`json_each('[0]')`)
          .where(
            notExists(
              db
                .select({ id: videos.id })
                .from(videos)
                .where(
                  and(
                    eq(videos.file, file),
                    sql`json_extract(${videos.multipartUpload},'$.uploadId')=${uploadId}`,
                  ),
                ),
            ),
          ),
      )
      .onConflictDoNothing()
      .run();
    await armMaintenance(env, Date.now() + 1000);
  };
  return {
    async initialize(id, user, contentType) {
      let created: { file: string; uploadId: string } | undefined;
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const v = await read(id, user);
          assertMultipartInitialization(v.status);
          const size = sizeOf(v);
          let session = v.multipart_upload
            ? (JSON.parse(v.multipart_upload) as Session)
            : null;
          if (!session) {
            const uploadId = await createR2MultipartUpload(
              env,
              v.file,
              contentType,
            );
            created = { file: v.file, uploadId };
            session = {
              uploadId,
              contentType,
              partSize: multipartPartSize(size),
            };
            const key = await cleanupKey(v.file, uploadId);
            const adopted = await db
              .update(videos)
              .set({ multipartUpload: session, uploadHeartbeatAt: NOW })
              .where(
                and(
                  matches(id, user, v),
                  notExists(
                    db
                      .select({ id: externalTasks.id })
                      .from(externalTasks)
                      .where(eq(externalTasks.dedupeKey, key)),
                  ),
                ),
              )
              .returning({ id: videos.id });
            if (!adopted.length) {
              await abandon(v.file, user, uploadId);
              created = undefined;
              continue;
            }
          } else {
            const touched = await db
              .update(videos)
              .set({ uploadHeartbeatAt: NOW })
              .where(matches(id, user, v))
              .returning({ id: videos.id });
            if (!touched.length) continue;
          }
          return {
            part_size: session.partSize,
            part_count: Math.ceil(size / session.partSize),
          };
        }
        throw new UploadSessionError(
          "Upload session changed; retry initialization",
        );
      } catch (error) {
        if (created)
          try {
            await abandon(created.file, user, created.uploadId);
          } catch {
            console.error(
              JSON.stringify({
                event: "multipart_initialization_cleanup_deferred",
                videoId: id,
              }),
            );
          }
        throw error;
      }
    },
    async partUrl(id, user, partNumber) {
      const v = await read(id, user),
        session = active(v),
        size = sizeOf(v);
      const length = multipartPartLength(size, session.partSize, partNumber);
      const upload_url = await presignR2UploadPart(
        env,
        v.file,
        session.uploadId,
        partNumber,
        session.contentType,
        length,
      );
      const touched = await db
        .update(videos)
        .set({ uploadHeartbeatAt: NOW })
        .where(matches(id, user, v))
        .returning({ id: videos.id });
      if (!touched.length)
        throw new UploadSessionError("Upload session changed");
      return { upload_url };
    },
    async complete(id, user, parts) {
      const v = await read(id, user);
      if (uploadConfirmed(v.status)) return null;
      const session = active(v),
        size = sizeOf(v),
        ordered = orderedMultipartParts(size, session.partSize, parts);
      // Keep a delayed orphan cleanup before storage I/O, including crashes or a
      // completion arriving after video deletion's immediate cleanup.
      await armMaintenance(env, Date.now() + 1000);
      const finishKey =
        "multipart-finish:" +
        (await sha256Hex(JSON.stringify([v.file, session.uploadId])));
      await db
        .insert(externalTasks)
        .values({
          kind: "multipart_cleanup",
          payload: {
            file_key: v.file,
            user_id: user,
            bytes: 0,
            multipart_upload_id: session.uploadId,
          },
          dedupeKey: finishKey,
          availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours')`,
        })
        .onConflictDoUpdate({
          target: externalTasks.dedupeKey,
          set: {
            completedAt: null,
            deadAt: null,
            availableAt: sql`excluded.available_at`,
          },
          setWhere: and(
            isNull(externalTasks.lockedAt),
            or(
              isNotNull(externalTasks.completedAt),
              isNotNull(externalTasks.deadAt),
            ),
          ),
        })
        .run();
      let actual = await getR2ObjectSize(env, v.file);
      if (actual === null) {
        try {
          await completeR2MultipartUpload(
            env,
            v.file,
            session.uploadId,
            ordered,
          );
        } catch (error) {
          if (!multipartObjectMatches(await getR2ObjectSize(env, v.file), size))
            throw error;
        }
        actual = await getR2ObjectSize(env, v.file);
      }
      assertMultipartObjectSize(actual, size);
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: id }),
        key = "job:" + message.job_id;
      const result = await runD1Batch(database, [
        db.insert(externalTasks).select(
          db
            .select(
              insertSelectValues(externalTasks, {
                kind: "sqs_job",
                payload: { message },
                dedupeKey: key,
              }),
            )
            .from(videos)
            .where(matches(id, user, v)),
        ),
        db
          .update(videos)
          .set({
            status: "pending",
            errorMessage: "",
            multipartUpload: null,
            uploadHeartbeatAt: null,
          })
          .where(and(sql`changes()=1`, matches(id, user, v))),
        db
          .select({ id: externalTasks.id })
          .from(externalTasks)
          .where(eq(externalTasks.dedupeKey, key)),
      ]);
      if (result[2].results[0]) return Number(result[2].results[0].id);
      const current = await read(id, user);
      if (current.file === v.file && uploadConfirmed(current.status))
        return null;
      throw new UploadSessionError(
        "Upload session changed before confirmation",
      );
    },
    async hasUploadingFile(file) {
      return Boolean(
        await db
          .select({ id: videos.id })
          .from(videos)
          .where(and(eq(videos.file, file), eq(videos.status, "uploading")))
          .limit(1)
          .get(),
      );
    },
    async referencesFile(file, uploadId) {
      return Boolean(
        await db
          .select({ id: videos.id })
          .from(videos)
          .where(
            and(
              eq(videos.file, file),
              uploadId === undefined
                ? undefined
                : sql`json_extract(${videos.multipartUpload},'$.uploadId')=${uploadId}`,
            ),
          )
          .limit(1)
          .get(),
      );
    },
  };
}
