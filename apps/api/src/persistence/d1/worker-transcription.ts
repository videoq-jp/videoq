import { and, eq, exists, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectFields,
  insertSelectValues,
  runD1Batch,
} from "../../db/d1/query-builders";
import {
  videos,
  users,
  videoIndexVersions as versions,
  videoTranscriptionRuns as runs,
  videoTranscriptionChunks as chunks,
  mutationReceipts as receipts,
  scenes,
  sceneStaging,
  sceneIndexRuns,
  externalTasks,
} from "../../db/schema/sqlite";
import {
  transcriptionCompletion,
  transcriptionFinishAllowed,
  transcriptionRunReusable,
  validateTranscriptionBegin,
  validateTranscriptionFinish,
} from "../../domain/media/transcription-policy";
import { transcriptionDrizzleLogic as logic } from "../transcription-policy-sql";
import { buildJobMessage } from "../../lib/job-message";
import type { WorkerTranscriptionRepository } from "../contracts/worker-transcription";
import {
  enqueueCurrentSceneDeletes,
  enqueueStagedSceneDeletes,
} from "./scene-index-writer";
export function createD1WorkerTranscriptionRepository(
  database: D1Database,
): WorkerTranscriptionRepository {
  const db = createD1Connection(database);
  const receipt = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  return {
    async readSource(videoId) {
      const result = await db.batch([
        db
          .insert(versions)
          .select(
            db
              .select(
                insertSelectFields(versions, {
                  videoId: videos.id,
                  revision: sql`${crypto.randomUUID()}`,
                }),
              )
              .from(videos)
              .where(eq(videos.id, videoId)),
          )
          .onConflictDoNothing({ target: versions.videoId }),
        db
          .select({
            videoId: videos.id,
            userId: videos.userId,
            title: videos.title,
            sourceRevision: versions.revision,
            fileKey: videos.file,
            status: videos.status,
            sourceType: videos.sourceType,
            youtubeVideoId: videos.youtubeVideoId,
            transcriptionLanguage: videos.transcriptionLanguage,
            searchapiKeyEncrypted: sql<
              string | null
            >`CASE WHEN ${videos.sourceType}='youtube' THEN ${users.searchapiApiKeyEncrypted} ELSE NULL END`,
          })
          .from(videos)
          .innerJoin(users, eq(users.id, videos.userId))
          .innerJoin(versions, eq(versions.videoId, videos.id))
          .where(eq(videos.id, videoId)),
      ]);
      return result[1][0] ?? null;
    },
    async begin(input, expectedStatus) {
      validateTranscriptionBegin(expectedStatus);
      return (
        (
          await db
            .update(videos)
            .set({ status: "processing", errorMessage: "" })
            .where(
              and(
                eq(videos.id, input.videoId),
                eq(videos.userId, input.userId),
                eq(videos.file, input.fileKey),
                eq(videos.status, expectedStatus),
                exists(
                  db
                    .select({ id: versions.videoId })
                    .from(versions)
                    .where(
                      and(
                        eq(versions.videoId, videos.id),
                        eq(versions.revision, input.sourceRevision),
                      ),
                    ),
                ),
              ),
            )
            .returning({ id: videos.id })
        ).length > 0
      );
    },
    async finish(input, transcript, errorCode, runId) {
      validateTranscriptionFinish(transcript, errorCode);
      if (
        transcript !== null &&
        new TextEncoder().encode(transcript).length > 1_800_000
      )
        throw new Error("Transcript exceeds D1 row budget");
      const reusable = transcriptionRunReusable(
        {
          sameFile: eq(runs.fileKey, videos.file),
          sameRevision: eq(runs.transcriptHash, versions.revision),
          incomplete: isNull(runs.completedAt),
        },
        logic,
      );
      const completeChunks = db
        .select({ count: sql<number>`count(*)` })
        .from(chunks)
        .where(and(eq(chunks.runId, runs.runId), isNotNull(chunks.segments)));
      const allowed = transcriptionFinishAllowed(
        {
          processing: eq(videos.status, "processing"),
          error: eq(videos.status, "error"),
          hasRun: sql`${runId ?? null} IS NOT NULL`,
          completeCurrentRun: exists(
            db
              .select({ id: runs.runId })
              .from(runs)
              .where(
                and(
                  eq(runs.videoId, videos.id),
                  eq(runs.runId, sql`${runId ?? null}`),
                  reusable,
                  eq(runs.chunkCount, completeChunks),
                ),
              ),
          ),
        },
        logic,
      );
      const token = crypto.randomUUID();
      const sameRevision = db
        .select({ value: receipts.effectApplied })
        .from(receipts)
        .where(eq(receipts.token, token));
      const completion = transcriptionCompletion(
        sql`(${sameRevision})=1`,
        sql`${transcript} IS NOT NULL`,
        sql`${errorCode ?? ""}`,
        logic,
      );
      const saved = transcriptionCompletion(
        eq(receipts.effectApplied, true),
        sql`${transcript} IS NOT NULL`,
        sql`${errorCode ?? ""}`,
        logic,
      ).saveTranscript;
      const message = buildJobMessage("index_video_transcript", {
        video_id: input.videoId,
      });
      const result = await runD1Batch<{ status: string }>(database, [
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'transcription_finish'`,
                resourceId: videos.id,
                effectApplied: eq(versions.revision, input.sourceRevision),
              }),
            )
            .from(videos)
            .innerJoin(versions, eq(versions.videoId, videos.id))
            .where(
              and(
                eq(videos.id, input.videoId),
                eq(videos.userId, input.userId),
                eq(videos.file, input.fileKey),
                allowed,
              ),
            ),
        ),
        db
          .update(videos)
          .set({
            transcript: sql`CASE WHEN ${completion.saveTranscript} THEN ${transcript} ELSE ${videos.transcript} END`,
            status: completion.status,
            errorMessage: completion.error,
          })
          .where(and(eq(videos.id, input.videoId), receipt(token))),
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token + ":saved"}`,
                kind: sql`'transcription_saved'`,
                resourceId: receipts.resourceId,
              }),
            )
            .from(receipts)
            .where(and(eq(receipts.token, token), saved)),
        ),
        db
          .update(versions)
          .set({ revision: crypto.randomUUID() })
          .where(
            and(eq(versions.videoId, input.videoId), receipt(token + ":saved")),
          ),
        enqueueCurrentSceneDeletes(database, input.videoId, token + ":saved"),
        enqueueStagedSceneDeletes(database, input.videoId, token + ":saved"),
        db
          .delete(scenes)
          .where(
            and(eq(scenes.videoId, input.videoId), receipt(token + ":saved")),
          ),
        db
          .delete(sceneStaging)
          .where(
            and(
              inArray(
                sceneStaging.runId,
                db
                  .select({ id: sceneIndexRuns.id })
                  .from(sceneIndexRuns)
                  .where(eq(sceneIndexRuns.videoId, input.videoId)),
              ),
              receipt(token + ":saved"),
            ),
          ),
        db.insert(externalTasks).select(
          db
            .select(
              insertSelectValues(externalTasks, {
                kind: "sqs_job",
                payload: { message },
                dedupeKey: `job:${message.job_id}`,
              }),
            )
            .from(receipts)
            .where(eq(receipts.token, token + ":saved")),
        ),
        db
          .select({ status: videos.status })
          .from(videos)
          .where(
            and(
              eq(videos.id, input.videoId),
              eq(videos.userId, input.userId),
              eq(videos.file, input.fileKey),
            ),
          ),
        db
          .update(runs)
          .set({ completedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` })
          .where(and(eq(runs.runId, sql`${runId ?? null}`), receipt(token))),
        db
          .delete(receipts)
          .where(inArray(receipts.token, [token, token + ":saved"])),
      ]);
      return result[9].results[0]?.status ?? null;
    },
  };
}
