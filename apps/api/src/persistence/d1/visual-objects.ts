import {
  and,
  eq,
  ne,
  exists,
  not,
  isNull,
  or,
  sql,
  inArray,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  visualObjectAttempts as attempts,
  videoVisualRuns as runs,
  videoVisualChunks as chunks,
  videos,
} from "../../db/schema/sqlite";
import {
  visualAttemptAllowed,
  visualObjectAttempt,
  visualObjectDesired,
  visualRunMutable,
  visualSourceCurrent,
} from "../../application/visual-checkpoint-policy";
import { visualDrizzleLogic as logic } from "../visual-policy-sql";
import type {
  VisualCleanup,
  VisualObjectCleanupRepository,
} from "../contracts/visual-object-cleanup";
export type { VisualCleanup } from "../contracts/visual-object-cleanup";

const builder = new QueryBuilder();
const current = visualSourceCurrent(
  eq(runs.fileKey, videos.file),
  eq(videos.sourceType, "uploaded"),
  logic,
);
const mutable = visualRunMutable(current, ne(runs.status, "ready"), logic);
export function visualObjectDesiredPredicate() {
  const desired = visualObjectDesired(
    {
      current,
      manifest: eq(attempts.kind, "manifest"),
      ready: eq(runs.status, "ready"),
      winningManifest: eq(runs.publicationVersion, attempts.objectVersion),
      chunk: eq(attempts.kind, "chunk"),
      winningChunk: exists(
        builder
          .select({ run: chunks.runId })
          .from(chunks)
          .where(
            and(
              eq(chunks.runId, runs.runId),
              eq(chunks.chunkIndex, attempts.chunkIndex),
              eq(chunks.objectVersion, attempts.objectVersion),
            ),
          ),
      ),
    },
    logic,
  );
  return exists(
    builder
      .select({ run: runs.runId })
      .from(runs)
      .innerJoin(videos, eq(videos.id, runs.videoId))
      .where(
        and(
          eq(runs.runId, attempts.runId),
          eq(videos.id, attempts.videoId),
          eq(videos.file, attempts.fileKey),
          desired,
        ),
      ),
  );
}
export async function beginVisualObject(
  database: D1Database,
  videoId: number,
  runId: string,
  version: string,
  index?: number,
) {
  const db = createD1Connection(database),
    { id, kind } = visualObjectAttempt(version, index);
  const allowed = visualAttemptAllowed(
    mutable,
    sql`${index ?? null} IS NOT NULL`,
    exists(
      db
        .select({ run: chunks.runId })
        .from(chunks)
        .where(
          and(
            eq(chunks.runId, runs.runId),
            eq(chunks.chunkIndex, index ?? -1),
            isNull(chunks.frameCount),
          ),
        ),
    ),
    logic,
  );
  const available = sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')`;
  const result = await runD1Batch(database, [
    db
      .insert(attempts)
      .select(
        db
          .select(
            insertSelectFields(attempts, {
              id: sql`${id}`,
              kind: sql`${kind}`,
              videoId: videos.id,
              runId: runs.runId,
              fileKey: runs.fileKey,
              chunkIndex: sql`${index ?? null}`,
              objectVersion: sql`${version}`,
              expiresAt: available,
              availableAt: available,
            }),
          )
          .from(runs)
          .innerJoin(videos, eq(videos.id, runs.videoId))
          .where(and(eq(videos.id, videoId), eq(runs.runId, runId), allowed)),
      )
      .onConflictDoNothing({ target: attempts.id }),
    db
      .select({ id: attempts.id })
      .from(attempts)
      .innerJoin(runs, eq(runs.runId, attempts.runId))
      .innerJoin(videos, eq(videos.id, runs.videoId))
      .where(
        and(
          eq(attempts.id, id),
          eq(attempts.videoId, videoId),
          eq(attempts.runId, runId),
          eq(attempts.status, "pending"),
          sql`julianday(${attempts.expiresAt})>julianday('now')`,
          eq(videos.file, attempts.fileKey),
          mutable,
        ),
      ),
  ]);
  return result[1].results.length > 0;
}
export function createVisualObjectCleanup(
  database: D1Database,
): VisualObjectCleanupRepository {
  const db = createD1Connection(database);
  return {
    async claim(): Promise<VisualCleanup | null> {
      const candidate = db
        .select({ id: attempts.id })
        .from(attempts)
        .where(
          and(
            ne(attempts.status, "cleaned"),
            sql`julianday(${attempts.availableAt})<=julianday('now')`,
            or(
              isNull(attempts.leaseToken),
              sql`julianday(${attempts.leaseUntil})<=julianday('now')`,
            ),
            not(visualObjectDesiredPredicate()),
          ),
        )
        .orderBy(attempts.availableAt, attempts.id)
        .limit(1);
      const [row] = await db
        .update(attempts)
        .set({
          status: "deleting",
          leaseToken: crypto.randomUUID(),
          leaseUntil: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')`,
          attempts: sql`${attempts.attempts}+1`,
        })
        .where(inArray(attempts.id, candidate))
        .returning({
          id: attempts.id,
          kind: attempts.kind,
          file_key: attempts.fileKey,
          run_id: attempts.runId,
          chunk_index: attempts.chunkIndex,
          object_version: attempts.objectVersion,
          lease_token: attempts.leaseToken,
        });
      return row ? { ...row, lease_token: row.lease_token! } : null;
    },
    async complete(task) {
      const rows = await db
        .update(attempts)
        .set({
          status: "cleaned",
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: "",
        })
        .where(
          and(
            eq(attempts.id, task.id),
            eq(attempts.status, "deleting"),
            eq(attempts.leaseToken, task.lease_token),
            sql`julianday(${attempts.leaseUntil})>julianday('now')`,
          ),
        )
        .returning({ id: attempts.id });
      return rows.length > 0;
    },
    async retry(task) {
      await db
        .update(attempts)
        .set({
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: "VISUAL_OBJECT_DELETE_FAILED",
          availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')`,
        })
        .where(
          and(
            eq(attempts.id, task.id),
            eq(attempts.status, "deleting"),
            eq(attempts.leaseToken, task.lease_token),
          ),
        )
        .run();
    },
  };
}
