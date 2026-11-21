import {
  and,
  eq,
  gt,
  gte,
  isNull,
  isNotNull,
  exists,
  not,
  sql,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectFields,
  insertSelectValues,
} from "../../db/d1/query-builders";
import {
  videos,
  users,
  videoTranscriptionRuns as runs,
  videoTranscriptionChunks as chunks,
  videoIndexVersions as versions,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import {
  TRANSCRIPTION_LANES,
  TRANSCRIPTION_FAILURE_LIMIT,
  transcriptionPlan,
  transcriptionQuotaAllowed,
  transcriptionRejectionAllowed,
  transcriptionRunActive,
  transcriptionRunReusable,
  transcriptionSourceEligible,
  validTranscriptionSegments,
} from "../../application/transcription-policy";
import { quotaAllowsAdditional } from "../../application/quota-policy";
import { quotaDrizzleComparison } from "../quota-policy-sql";
import { transcriptionDrizzleLogic as logic } from "../transcription-policy-sql";
import type { TranscriptionCheckpoints } from "../contracts/transcription-checkpoints";
const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
export function createD1TranscriptionCheckpoints(
  database: D1Database,
): TranscriptionCheckpoints {
  const db = createD1Connection(database);
  const current = sql`strftime('%Y-%m',${users.usagePeriodStart})=strftime('%Y-%m','now')`;
  const used = sql`CASE WHEN ${current} THEN ${users.usedProcessingSeconds} ELSE 0 END`;
  const eligible = transcriptionSourceEligible(
    {
      pending: eq(videos.status, "pending"),
      processing: eq(videos.status, "processing"),
      error: eq(videos.status, "error"),
    },
    logic,
  );
  const reusable = transcriptionRunReusable(
    {
      sameFile: eq(runs.fileKey, videos.file),
      sameRevision: eq(runs.transcriptHash, versions.revision),
      incomplete: isNull(runs.completedAt),
    },
    logic,
  );
  const active = transcriptionRunActive(
    {
      belongsToVideo: eq(runs.videoId, videos.id),
      reusable,
      eligibleSource: eligible,
    },
    logic,
  );
  const projection = {
    videoId: runs.videoId,
    runId: runs.runId,
    fileKey: runs.fileKey,
    sourceRevision: runs.transcriptHash,
    durationMs: runs.durationMs,
    chunkSeconds: runs.chunkSeconds,
    chunkCount: runs.chunkCount,
    completed: sql<boolean>`${runs.completedAt} IS NOT NULL`.mapWith(Boolean),
    transcriptionLanguage: videos.transcriptionLanguage,
  };
  const runQuery = () =>
    db
      .select(projection)
      .from(runs)
      .innerJoin(videos, eq(videos.id, runs.videoId))
      .innerJoin(versions, eq(versions.videoId, videos.id));
  const activeRun = (videoId: number, runId: string) =>
    exists(
      runQuery().where(
        and(eq(videos.id, videoId), eq(runs.runId, runId), active),
      ),
    );
  const gate = (token: string, fresh = false) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(
          and(
            eq(receipts.token, token),
            fresh ? eq(receipts.effectApplied, false) : undefined,
          ),
        ),
    );
  return {
    async load(videoId, runId) {
      return (
        (await runQuery()
          .where(
            and(
              eq(runs.videoId, videoId),
              eq(runs.fileKey, videos.file),
              runId == null ? undefined : eq(runs.runId, runId),
            ),
          )
          .get()) ?? null
      );
    },
    async initialize(input, durationMs, chunkSeconds) {
      const { count, seconds } = transcriptionPlan(durationMs, chunkSeconds),
        token = crypto.randomUUID(),
        runId = crypto.randomUUID();
      const quota = transcriptionQuotaAllowed(
        {
          alreadyReserved: gt(videos.processingSeconds, 0),
          notOverQuota: sql`${users.isOverQuota} IS NOT TRUE`,
          representable: sql`${used}<=9007199254740991-${seconds}`,
          withinLimit: quotaAllowsAdditional(
            used,
            sql`${users.processingLimitMinutes}*60`,
            sql`${seconds}`,
            quotaDrizzleComparison,
          ),
        },
        logic,
      );
      const source = and(
        eq(videos.id, input.videoId),
        eq(videos.userId, input.userId),
        eq(videos.file, input.fileKey),
        eq(versions.revision, input.sourceRevision),
        eligible,
      );
      const result = await db.batch([
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'transcription_plan'`,
                resourceId: videos.id,
                effectApplied: exists(
                  db
                    .select({ id: runs.runId })
                    .from(runs)
                    .where(and(eq(runs.videoId, videos.id), reusable)),
                ),
              }),
            )
            .from(videos)
            .innerJoin(users, eq(users.id, videos.userId))
            .innerJoin(versions, eq(versions.videoId, videos.id))
            .where(and(source, quota)),
        ),
        db
          .update(users)
          .set({
            usedProcessingSeconds: sql`(${used})+${seconds}`,
            usedAiAnswers: sql`CASE WHEN ${current} THEN ${users.usedAiAnswers} ELSE 0 END`,
            usagePeriodStart: sql`CASE WHEN ${current} THEN ${users.usagePeriodStart} ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','start of month') END`,
          })
          .where(
            and(
              eq(
                users.id,
                db
                  .select({ id: videos.userId })
                  .from(videos)
                  .where(
                    and(
                      eq(videos.id, input.videoId),
                      eq(videos.processingSeconds, 0),
                    ),
                  ),
              ),
              gate(token, true),
            ),
          ),
        db
          .update(videos)
          .set({ processingSeconds: seconds })
          .where(
            and(
              eq(videos.id, input.videoId),
              eq(videos.processingSeconds, 0),
              gate(token, true),
            ),
          ),
        db
          .delete(runs)
          .where(and(eq(runs.videoId, input.videoId), gate(token, true))),
        db.insert(runs).select(
          db
            .select(
              insertSelectValues(runs, {
                videoId: input.videoId,
                runId,
                fileKey: input.fileKey,
                transcriptHash: input.sourceRevision,
                durationMs,
                chunkSeconds,
                chunkCount: count,
              }),
            )
            .from(receipts)
            .where(
              and(eq(receipts.token, token), eq(receipts.effectApplied, false)),
            ),
        ),
        db.insert(chunks).select(
          db
            .select(
              insertSelectFields(chunks, {
                runId: sql`${runId}`,
                chunkIndex: sql`value`,
              }),
            )
            .from(
              sql`json_each(${JSON.stringify(Array.from({ length: count }, (_, i) => i))})`,
            )
            .where(gate(token, true)),
        ),
        db
          .update(videos)
          .set({ status: "processing", errorMessage: "" })
          .where(and(eq(videos.id, input.videoId), gate(token))),
        runQuery().where(and(eq(runs.videoId, input.videoId), gate(token))),
        db
          .select({ kind: sql<string>`'quota'` })
          .from(videos)
          .innerJoin(versions, eq(versions.videoId, videos.id))
          .where(and(source, not(gate(token)))),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      return { run: result[7][0] ?? null, quotaExceeded: result[8].length > 0 };
    },
    async pendingHeads(runId, afterIndex) {
      const lane = sql`${chunks.chunkIndex}%${TRANSCRIPTION_LANES}`;
      const rows = await db
        .select({ index: sql<number>`min(${chunks.chunkIndex})` })
        .from(chunks)
        .where(
          and(
            eq(chunks.runId, runId),
            isNull(chunks.segments),
            afterIndex == null
              ? undefined
              : and(
                  gt(chunks.chunkIndex, afterIndex),
                  eq(lane, sql`${afterIndex}%${TRANSCRIPTION_LANES}`),
                ),
          ),
        )
        .groupBy(lane)
        .orderBy(lane);
      return rows.map((row) => row.index);
    },
    async chunkState(videoId, runId, index) {
      const row = await db
        .select({ completed: isNotNull(chunks.segments) })
        .from(runs)
        .innerJoin(videos, eq(videos.id, runs.videoId))
        .innerJoin(versions, eq(versions.videoId, videos.id))
        .innerJoin(chunks, eq(chunks.runId, runs.runId))
        .where(
          and(
            eq(videos.id, videoId),
            eq(runs.runId, runId),
            eq(chunks.chunkIndex, index),
            active,
          ),
        )
        .get();
      return { active: Boolean(row), completed: Boolean(row?.completed) };
    },
    async saveChunk(videoId, runId, index, segments) {
      const payload = JSON.stringify(segments);
      if (
        new TextEncoder().encode(payload).length > 1_000_000 ||
        !validTranscriptionSegments(segments)
      )
        throw new Error("Invalid transcription segments");
      const result = await db.batch([
        db
          .update(chunks)
          .set({
            segments,
            fallbackSegments: {},
            lastError: "",
            updatedAt: now,
          })
          .where(
            and(
              eq(chunks.runId, runId),
              eq(chunks.chunkIndex, index),
              isNull(chunks.segments),
              activeRun(videoId, runId),
            ),
          ),
        runQuery().where(
          and(
            eq(videos.id, videoId),
            eq(runs.runId, runId),
            active,
            exists(
              db
                .select({ id: chunks.runId })
                .from(chunks)
                .where(
                  and(
                    eq(chunks.runId, runs.runId),
                    eq(chunks.chunkIndex, index),
                  ),
                ),
            ),
          ),
        ),
      ]);
      return result[1].length > 0;
    },
    async readSegments(videoId, runId, afterIndex) {
      if (
        !(await runQuery()
          .where(and(eq(videos.id, videoId), eq(runs.runId, runId), active))
          .get())
      )
        return { active: false, rows: [], done: true };
      const page = await db
        .select({ index: chunks.chunkIndex, segments: chunks.segments })
        .from(chunks)
        .where(and(eq(chunks.runId, runId), gt(chunks.chunkIndex, afterIndex)))
        .orderBy(chunks.chunkIndex)
        .limit(20);
      const rows: typeof page = [];
      let bytes = 0;
      for (const item of page) {
        const size = new TextEncoder().encode(JSON.stringify(item)).length;
        if (rows.length && bytes + size > 1_050_000) break;
        rows.push(item);
        bytes += size;
      }
      return {
        active: true,
        rows,
        done: page.length < 20 && rows.length === page.length,
      };
    },
    async rejectNoAudio(input, runId, index) {
      const rejection = transcriptionRejectionAllowed(
        sql`${runId ?? null} IS NOT NULL`,
        exists(
          db
            .select({ id: runs.runId })
            .from(runs)
            .where(
              and(
                eq(runs.videoId, videos.id),
                eq(runs.runId, sql`${runId ?? null}`),
                isNull(runs.completedAt),
              ),
            ),
        ),
        logic,
      );
      const token = crypto.randomUUID();
      const result = await db.batch([
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'transcription_no_audio'`,
                resourceId: videos.id,
              }),
            )
            .from(videos)
            .innerJoin(versions, eq(versions.videoId, videos.id))
            .where(
              and(
                eq(videos.id, input.videoId),
                eq(videos.userId, input.userId),
                eq(videos.file, input.fileKey),
                eq(versions.revision, input.sourceRevision),
                eligible,
                rejection,
              ),
            ),
        ),
        db
          .update(chunks)
          .set({ lastError: "NO_AUDIO_STREAM", updatedAt: now })
          .where(
            and(
              eq(
                chunks.runId,
                db
                  .select({ id: runs.runId })
                  .from(runs)
                  .where(eq(runs.videoId, input.videoId)),
              ),
              eq(chunks.chunkIndex, sql`${index ?? null}`),
              gate(token),
            ),
          ),
        db
          .update(runs)
          .set({ completedAt: now })
          .where(
            and(
              eq(runs.videoId, input.videoId),
              isNull(runs.completedAt),
              gate(token),
            ),
          ),
        db
          .update(videos)
          .set({ status: "error", errorMessage: "NO_AUDIO_STREAM" })
          .where(and(eq(videos.id, input.videoId), gate(token))),
        db
          .select({ token: receipts.token })
          .from(receipts)
          .where(eq(receipts.token, token)),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      return result[4].length > 0;
    },
    async recordFailure(videoId, runId, index) {
      await db.batch([
        db
          .update(chunks)
          .set({
            failures: sql`${chunks.failures}+1`,
            lastError: "TRANSCRIPTION_CHUNK_FAILED",
            updatedAt: now,
          })
          .where(
            and(
              eq(chunks.runId, runId),
              eq(chunks.chunkIndex, index),
              isNull(chunks.segments),
              activeRun(videoId, runId),
            ),
          ),
        db
          .update(videos)
          .set({ status: "error", errorMessage: "TRANSCRIPTION_CHUNK_FAILED" })
          .where(
            and(
              eq(videos.id, videoId),
              exists(
                db
                  .select({ id: runs.runId })
                  .from(runs)
                  .innerJoin(versions, eq(versions.videoId, runs.videoId))
                  .innerJoin(chunks, eq(chunks.runId, runs.runId))
                  .where(
                    and(
                      eq(runs.runId, runId),
                      eq(chunks.chunkIndex, index),
                      gte(chunks.failures, TRANSCRIPTION_FAILURE_LIMIT),
                      isNull(chunks.segments),
                      active,
                    ),
                  ),
              ),
            ),
          ),
      ]);
    },
  };
}
