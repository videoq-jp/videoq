import type { D1Database } from "@cloudflare/workers-types";
import {
  and,
  or,
  eq,
  ne,
  gt,
  isNull,
  isNotNull,
  exists,
  not,
  inArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectFields,
  insertSelectValues,
  runD1Batch,
} from "../../db/d1/query-builders";
import {
  sceneIndexTasks as tasks,
  scenes,
  videos,
  sceneStaging,
  sceneIndexRuns as runs,
  videoIndexVersions as versions,
  videoIndexHeads as heads,
  mutationReceipts as receipts,
  externalTasks,
} from "../../db/schema/sqlite";
import type {
  SceneIndexTask,
  SceneIndexTaskRepository,
} from "../contracts/scene-index";
import { buildJobMessage } from "../../lib/job-message";

const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
export function createD1SceneIndexTaskRepository(
  database: D1Database,
): SceneIndexTaskRepository {
  const db = createD1Connection(database);
  const t = alias(tasks, "t");
  // Superseded runs cannot become heads again; vector IDs identify immutable content.
  const desired = () =>
    or(
      exists(
        db
          .select({ id: scenes.id })
          .from(scenes)
          .innerJoin(videos, eq(videos.id, scenes.videoId))
          .where(
            and(
              eq(scenes.id, t.sceneId),
              eq(scenes.dimensions, t.dimensions),
              eq(scenes.revision, t.revision),
              eq(sql`coalesce(${scenes.vectorId},${scenes.id})`, t.vectorId),
              eq(videos.id, t.videoId),
              eq(videos.userId, t.userId),
            ),
          ),
      ),
      exists(
        db
          .select({ id: sceneStaging.sceneId })
          .from(sceneStaging)
          .innerJoin(runs, eq(runs.id, sceneStaging.runId))
          .innerJoin(videos, eq(videos.id, runs.videoId))
          .innerJoin(versions, eq(versions.videoId, videos.id))
          .innerJoin(
            heads,
            and(
              eq(heads.videoId, videos.id),
              eq(heads.dimensions, runs.dimensions),
            ),
          )
          .where(
            and(
              eq(sceneStaging.sceneId, t.sceneId),
              eq(sceneStaging.vectorId, t.vectorId),
              eq(runs.id, t.revision),
              eq(runs.dimensions, t.dimensions),
              eq(runs.videoId, t.videoId),
              eq(runs.userId, t.userId),
              eq(videos.userId, t.userId),
              eq(runs.sourceRevision, versions.revision),
              eq(heads.runId, runs.id),
              eq(runs.status, "staging"),
            ),
          ),
      ),
    )!;
  const owns = (task: Pick<SceneIndexTask, "id" | "leaseToken">) =>
    and(
      eq(tasks.id, task.id),
      eq(tasks.leaseToken, task.leaseToken),
      isNull(tasks.completedAt),
      sql`julianday(${tasks.leaseUntil})>julianday('now')`,
    )!;
  const receipt = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  return {
    async claim(options = {}) {
      const candidate = db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            isNull(tasks.completedAt),
            sql`julianday(${tasks.availableAt})<=julianday('now')`,
            or(
              isNull(tasks.leaseToken),
              sql`julianday(${tasks.leaseUntil})<=julianday('now')`,
            ),
          ),
        )
        .orderBy(...(options.preferUpserts ? [sql`CASE WHEN ${tasks.operation}='upsert' THEN 0 ELSE 1 END`] : []), tasks.availableAt, tasks.createdAt, tasks.id)
        .limit(1);
      const row = await db
        .update(tasks)
        .set({
          leaseToken: crypto.randomUUID(),
          leaseUntil: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+300 seconds')`,
          attempts: sql`${tasks.attempts}+1`,
        })
        .where(eq(tasks.id, candidate))
        .returning()
        .get();
      return row
        ? {
            ...row,
            dimensions: row.dimensions as 768 | 1536,
            leaseToken: row.leaseToken!,
          }
        : null;
    },
    async isDesired(taskId) {
      return Boolean(
        (
          await db
            .select({ desired: desired() })
            .from(t)
            .where(eq(t.id, taskId))
            .get()
        )?.desired,
      );
    },
    async accept(task) {
      return (
        (
          await db
            .update(tasks)
            .set({ acceptedAt: now, embedding: null, lastErrorCode: "" })
            .where(owns(task))
            .returning({ id: tasks.id })
        ).length > 0
      );
    },
    async complete(task) {
      const token = crypto.randomUUID();
      const message = buildJobMessage("index_video_transcript", {
        video_id: task.videoId,
      });
      const ready = exists(
        db
          .select({ id: videos.id })
          .from(videos)
          .innerJoin(versions, eq(versions.videoId, videos.id))
          .innerJoin(
            heads,
            and(
              eq(heads.videoId, videos.id),
              eq(heads.dimensions, task.dimensions),
            ),
          )
          .innerJoin(runs, eq(runs.id, heads.runId))
          .where(
            and(
              eq(videos.id, task.videoId),
              eq(videos.userId, task.userId),
              eq(videos.status, "indexing"),
              eq(runs.id, task.revision),
              eq(runs.status, "published"),
              eq(runs.pendingVectors, 0),
              eq(runs.sourceRevision, versions.revision),
            ),
          ),
      );
      const result = await runD1Batch(database, [
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'scene_ready'`,
                resourceId: tasks.videoId,
              }),
            )
            .from(tasks)
            .where(owns(task)),
        ),
        db
          .update(tasks)
          .set({
            completedAt: now,
            embedding: null,
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: "",
          })
          .where(owns(task))
          .returning({ id: tasks.id }),
        db
          .update(runs)
          .set({ pendingVectors: sql`${runs.pendingVectors}-1` })
          .where(
            and(
              eq(runs.id, task.revision),
              eq(runs.videoId, task.videoId),
              eq(runs.userId, task.userId),
              eq(runs.dimensions, task.dimensions),
              eq(runs.status, "published"),
              gt(runs.pendingVectors, 0),
              sql`${task.operation}='upsert'`,
              receipt(token),
            ),
          ),
        db
          .insert(externalTasks)
          .select(
            db
              .select(
                insertSelectValues(externalTasks, {
                  kind: "sqs_job",
                  payload: { message },
                  dedupeKey: `scene-ready:${task.dimensions}:${task.videoId}:${task.revision}`,
                }),
              )
              .from(receipts)
              .where(
                and(
                  sql`${task.operation}='upsert'`,
                  eq(receipts.token, token),
                  ready,
                ),
              ),
          )
          .onConflictDoNothing({ target: externalTasks.dedupeKey }),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      return result[1].results.length > 0;
    },
    async retry(task, code) {
      return (
        (
          await db
            .update(tasks)
            .set({
              leaseToken: null,
              leaseUntil: null,
              lastErrorCode: code,
              availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||CASE WHEN ${code}='VECTORIZE_NOT_READY' THEN min(60,5*(1 << min(${tasks.attempts},4))) ELSE min(3600,5*(1 << min(${tasks.attempts},10))) END||' seconds')`,
            })
            .where(owns(task))
            .returning({ id: tasks.id })
        ).length > 0
      );
    },
    async reconcileObsolete(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new Error("Invalid index reconciliation limit");
      const obsolete = await db
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.operation, "upsert"),
            isNotNull(t.completedAt),
            ne(t.lastErrorCode, "SUPERSEDED"),
            not(desired()),
          ),
        )
        .orderBy(t.completedAt, t.id)
        .limit(limit);
      if (!obsolete.length) return 0;
      const selected = and(
        // D1 permits 100 bound parameters per statement. Keep the bounded ID
        // page in one parameter so predicates and defaults retain room too.
        inArray(t.id, db.select({ id: sql<string>`value` })
          .from(sql`json_each(${JSON.stringify(obsolete.map(row => row.id))})`)),
        not(desired()),
      );
      const d = alias(tasks, "d");
      const result = await runD1Batch(database, [
        db
          .insert(tasks)
          .select(
            db
              .select(
                insertSelectFields(tasks, {
                  id: sql`'d:'||${t.dimensions}||':'||${t.vectorId}`,
                  operation: sql`'delete'`,
                  vectorId: t.vectorId,
                  sceneId: t.sceneId,
                  revision: t.revision,
                  videoId: t.videoId,
                  userId: t.userId,
                  dimensions: t.dimensions,
                }),
              )
              .from(t)
              .where(selected),
          )
          .onConflictDoUpdate({
            target: tasks.id,
            set: { completedAt: null, availableAt: now },
            setWhere: or(
              isNull(tasks.leaseToken),
              sql`julianday(${tasks.leaseUntil})<=julianday('now')`,
            ),
          })
          .returning({ id: tasks.id }),
        db
          .update(tasks)
          .set({ lastErrorCode: "SUPERSEDED" })
          .where(
            inArray(
              tasks.id,
              db
                .select({ id: t.id })
                .from(t)
                .where(
                  and(
                    selected,
                    exists(
                      db
                        .select({ id: d.id })
                        .from(d)
                        .where(
                          eq(
                            d.id,
                            sql`'d:'||${t.dimensions}||':'||${t.vectorId}`,
                          ),
                        ),
                    ),
                  ),
                ),
            ),
          ),
      ]);
      return result[0].results.length;
    },
  };
}
