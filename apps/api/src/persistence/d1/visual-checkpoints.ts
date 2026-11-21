import {
  and,
  eq,
  ne,
  exists,
  notExists,
  isNull,
  isNotNull,
  sql,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields } from "../../db/d1/query-builders";
import {
  videos,
  videoVisualRuns as runs,
  videoVisualChunks as chunks,
  visualObjectAttempts as attempts,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import {
  visualAttemptAdoptable,
  visualChunkPublishAllowed,
  visualPlan,
  visualReadyAllowed,
  visualRunMutable,
  visualRunRecoveryAllowed,
  visualSourceCurrent,
  validateVisualCheckpoint,
  visualAttemptAllowed,
} from "../../application/visual-checkpoint-policy";
import { visualDrizzleLogic as logic } from "../visual-policy-sql";
import { beginVisualObject } from "./visual-objects";
import type {
  VisualCheckpoints,
  VisualRun,
} from "../contracts/visual-checkpoints";
const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
export function createD1VisualCheckpoints(
  database: D1Database,
): VisualCheckpoints {
  const db = createD1Connection(database);
  const current = visualSourceCurrent(
    eq(runs.fileKey, videos.file),
    eq(videos.sourceType, "uploaded"),
    logic,
  );
  const mutable = visualRunMutable(current, ne(runs.status, "ready"), logic);
  const currentRun = exists(
    db
      .select({ id: videos.id })
      .from(videos)
      .where(and(eq(videos.id, runs.videoId), current)),
  );
  const projection = {
    videoId: runs.videoId,
    runId: runs.runId,
    fileKey: runs.fileKey,
    durationMs: runs.durationMs,
    chunkCount: runs.chunkCount,
    status: sql<VisualRun["status"]>`${runs.status}`,
    publicationVersion: runs.publicationVersion,
  };
  const receipt = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  return {
    beginObject: (videoId, runId, version, index) =>
      beginVisualObject(database, videoId, runId, version, index),
    async load(videoId, runId) {
      return (
        (await db
          .select(projection)
          .from(runs)
          .innerJoin(videos, eq(videos.id, runs.videoId))
          .where(
            and(
              eq(videos.id, videoId),
              current,
              runId == null ? undefined : eq(runs.runId, runId),
            ),
          )
          .get()) ?? null
      );
    },
    async initialize(videoId, fileKey, durationMs) {
      const { count } = visualPlan(durationMs),
        runId = crypto.randomUUID(),
        token = crypto.randomUUID();
      const initial = and(
        eq(videos.id, videoId),
        visualSourceCurrent(
          eq(videos.file, fileKey),
          eq(videos.sourceType, "uploaded"),
          logic,
        ),
      );
      const result = await db.batch([
        db
          .delete(runs)
          .where(
            and(
              eq(runs.videoId, videoId),
              ne(runs.fileKey, fileKey),
              exists(db.select({ id: videos.id }).from(videos).where(initial)),
            ),
          ),
        db
          .insert(runs)
          .select(
            db
              .select(
                insertSelectFields(runs, {
                  videoId: videos.id,
                  runId: sql`${runId}`,
                  fileKey: sql`${fileKey}`,
                  durationMs: sql`${durationMs}`,
                  chunkCount: sql`${count}`,
                }),
              )
              .from(videos)
              .where(initial),
          )
          .onConflictDoNothing({ target: runs.videoId }),
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'visual_plan'`,
                resourceId: sql`${videoId}`,
              }),
            )
            .from(videos)
            .where(and(eq(videos.id, videoId), sql`changes()=1`)),
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
            .where(receipt(token)),
        ),
        db
          .select(projection)
          .from(runs)
          .innerJoin(videos, eq(videos.id, runs.videoId))
          .where(
            and(eq(videos.id, videoId), eq(videos.file, fileKey), current),
          ),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      return result[4][0] ?? null;
    },
    async pending(runId) {
      const rows = await db
        .select({ index: chunks.chunkIndex })
        .from(chunks)
        .innerJoin(runs, eq(runs.runId, chunks.runId))
        .innerJoin(videos, eq(videos.id, runs.videoId))
        .where(and(eq(runs.runId, runId), mutable, isNull(chunks.frameCount)))
        .orderBy(chunks.chunkIndex);
      return rows.map((row) => row.index);
    },
    async chunks(videoId, runId) {
      const condition = and(
        eq(videos.id, videoId),
        eq(runs.runId, runId),
        current,
      );
      const result = await db.batch([
        db
          .select({ id: runs.runId })
          .from(runs)
          .innerJoin(videos, eq(videos.id, runs.videoId))
          .where(condition),
        db
          .select({
            index: chunks.chunkIndex,
            frameCount: chunks.frameCount,
            objectVersion: chunks.objectVersion,
          })
          .from(runs)
          .innerJoin(videos, eq(videos.id, runs.videoId))
          .innerJoin(chunks, eq(chunks.runId, runs.runId))
          .where(condition)
          .orderBy(chunks.chunkIndex),
      ]);
      return result[0].length ? result[1] : null;
    },
    async publishChunk(videoId, runId, index, frameCount, objectVersion) {
      validateVisualCheckpoint(frameCount, objectVersion);
      const winningChunk = exists(
        db
          .select({ id: chunks.runId })
          .from(chunks)
          .where(
            and(
              eq(chunks.runId, runId),
              eq(chunks.chunkIndex, index),
              eq(chunks.objectVersion, objectVersion),
            ),
          ),
      );
      const publish = visualChunkPublishAllowed(
        isNull(chunks.frameCount),
        exists(
          db
            .select({ id: attempts.id })
            .from(attempts)
            .where(
              and(
                eq(attempts.id, "c:" + objectVersion),
                eq(attempts.videoId, videoId),
                eq(attempts.runId, runId),
                eq(attempts.chunkIndex, index),
                eq(attempts.status, "pending"),
                sql`julianday(${attempts.expiresAt})>julianday('now')`,
              ),
            ),
        ),
        exists(
          db
            .select({ id: runs.runId })
            .from(runs)
            .innerJoin(videos, eq(videos.id, runs.videoId))
            .where(and(eq(videos.id, videoId), eq(runs.runId, runId), mutable)),
        ),
        logic,
      );
      const recover = visualRunRecoveryAllowed(
        {
          notReady: ne(runs.status, "ready"),
          noChunkErrors: notExists(
            db
              .select({ id: chunks.runId })
              .from(chunks)
              .where(and(eq(chunks.runId, runId), ne(chunks.lastError, ""))),
          ),
          winningChunk,
          current: currentRun,
        },
        logic,
      );
      const result = await db.batch([
        db
          .update(chunks)
          .set({ frameCount, objectVersion, lastError: "", updatedAt: now })
          .where(
            and(eq(chunks.runId, runId), eq(chunks.chunkIndex, index), publish),
          ),
        db
          .update(attempts)
          .set({ status: "published" })
          .where(
            and(
              eq(attempts.id, "c:" + objectVersion),
              eq(attempts.status, "pending"),
              winningChunk,
            ),
          ),
        db
          .update(runs)
          .set({ status: "processing", lastError: "" })
          .where(and(eq(runs.runId, runId), recover)),
        db
          .select({ objectVersion: chunks.objectVersion })
          .from(runs)
          .innerJoin(videos, eq(videos.id, runs.videoId))
          .innerJoin(chunks, eq(chunks.runId, runs.runId))
          .where(
            and(
              eq(videos.id, videoId),
              eq(runs.runId, runId),
              eq(chunks.chunkIndex, index),
              current,
            ),
          ),
      ]);
      const row = result[3][0];
      return {
        current: Boolean(row),
        objectVersion: row?.objectVersion ?? null,
      };
    },
    async ready(videoId, runId, objectVersion) {
      const adoptable = visualAttemptAdoptable(
        eq(attempts.status, "published"),
        eq(attempts.status, "pending"),
        sql`julianday(${attempts.expiresAt})>julianday('now')`,
        logic,
      );
      const complete = db
        .select({ count: sql<number>`count(*)` })
        .from(chunks)
        .where(
          and(
            eq(chunks.runId, runId),
            isNotNull(chunks.frameCount),
            isNotNull(chunks.objectVersion),
          ),
        );
      const frames = db
        .select({ count: sql<number>`sum(${chunks.frameCount})` })
        .from(chunks)
        .where(eq(chunks.runId, runId));
      const ready = visualReadyAllowed(
        {
          current: currentRun,
          adoptableAttempt: exists(
            db
              .select({ id: attempts.id })
              .from(attempts)
              .where(
                and(
                  eq(attempts.id, "m:" + objectVersion),
                  eq(attempts.runId, runs.runId),
                  adoptable,
                ),
              ),
          ),
          complete: eq(runs.chunkCount, complete),
          hasFrames: sql`(${frames})>0`,
        },
        logic,
      );
      const result = await db.batch([
        db
          .update(runs)
          .set({
            status: "ready",
            publicationVersion: sql`coalesce(${runs.publicationVersion},${objectVersion})`,
            completedAt: sql`coalesce(${runs.completedAt},${now})`,
            lastError: "",
          })
          .where(and(eq(runs.videoId, videoId), eq(runs.runId, runId), ready))
          .returning({ id: runs.runId }),
        db
          .update(attempts)
          .set({ status: "published" })
          .where(
            and(
              eq(attempts.id, "m:" + objectVersion),
              eq(attempts.status, "pending"),
              exists(
                db
                  .select({ id: runs.runId })
                  .from(runs)
                  .innerJoin(videos, eq(videos.id, runs.videoId))
                  .where(
                    and(
                      eq(runs.runId, runId),
                      eq(runs.status, "ready"),
                      eq(runs.publicationVersion, objectVersion),
                      eq(runs.fileKey, videos.file),
                    ),
                  ),
              ),
            ),
          ),
      ]);
      return result[0].length > 0;
    },
    async failure(videoId, runId, index) {
      const pending = exists(
        db
          .select({ id: chunks.runId })
          .from(chunks)
          .where(
            and(
              eq(chunks.runId, runId),
              eq(chunks.chunkIndex, sql`${index ?? null}`),
              isNull(chunks.frameCount),
            ),
          ),
      );
      const failure = visualAttemptAllowed(
        visualRunMutable(currentRun, ne(runs.status, "ready"), logic),
        sql`${index ?? null} IS NOT NULL`,
        pending,
        logic,
      );
      await db.batch([
        db
          .update(chunks)
          .set({
            failures: sql`${chunks.failures}+1`,
            lastError: "VISUAL_CHUNK_FAILED",
            updatedAt: now,
          })
          .where(
            and(
              eq(chunks.runId, runId),
              eq(chunks.chunkIndex, sql`${index ?? null}`),
              isNull(chunks.frameCount),
              exists(
                db
                  .select({ id: runs.runId })
                  .from(runs)
                  .innerJoin(videos, eq(videos.id, runs.videoId))
                  .where(
                    and(eq(videos.id, videoId), eq(runs.runId, runId), mutable),
                  ),
              ),
            ),
          ),
        db
          .update(runs)
          .set({ status: "error", lastError: "VISUAL_PROCESSING_FAILED" })
          .where(
            and(eq(runs.videoId, videoId), eq(runs.runId, runId), failure),
          ),
      ]);
    },
  };
}
