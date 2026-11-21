import {
  and,
  or,
  eq,
  ne,
  isNull,
  isNotNull,
  exists,
  inArray,
  sql,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectValues } from "../../db/d1/query-builders";
import {
  sceneIndexTasks as tasks,
  videoIndexVersions as versions,
  scenes,
  externalTasks,
} from "../../db/schema/sqlite";
import type { Vectorize } from "@cloudflare/workers-types";
import {
  buildJobMessage,
  JOB_REINDEX_VIDEO_TRANSCRIPT,
} from "../../lib/job-message";
import { SCENE_INDEX_VERIFY_INTERVAL_MS } from "../contracts/scene-index";
import type { SceneVectorIdentity } from "../contracts/scene-index-verification";
import { reconcileSceneVectors } from "../../features/maintenance/scene-index-service";

/** SQL retains source checks and the unique outbox insert; policy owns paging and repair selection. */
export async function reconcileMissingSceneVectors(
  database: D1Database,
  index: Vectorize,
  dimensions: 768 | 1536,
  limit = 50,
) {
  const db = createD1Connection(database);
  return reconcileSceneVectors(
    {
      nowMs: Date.now,
      readVectors: async (ids) => {
        // Vectorize limits getByIds to 20 IDs. Return only after every batch succeeds.
        const vectors: SceneVectorIdentity[] = [];
        for (let offset = 0; offset < ids.length; offset += 20) {
          vectors.push(
            ...(await index.getByIds(ids.slice(offset, offset + 20))),
          );
        }
        return vectors;
      },
      repository: {
        async due(dimensions, limit) {
          return db
            .select({
              id: tasks.id,
              vector_id: tasks.vectorId,
              video_id: tasks.videoId,
              user_id: tasks.userId,
              scene_id: tasks.sceneId,
              revision: tasks.revision,
              legacy_replay: sql<number>`${tasks.completedAt} IS NULL`,
              source_revision: versions.revision,
            })
            .from(tasks)
            .innerJoin(versions, eq(versions.videoId, tasks.videoId))
            .innerJoin(
              scenes,
              and(
                eq(scenes.vectorId, tasks.vectorId),
                eq(scenes.dimensions, tasks.dimensions),
                eq(scenes.revision, tasks.revision),
              ),
            )
            .where(
              and(
                eq(tasks.operation, "upsert"),
                eq(tasks.dimensions, dimensions),
                ne(tasks.lastErrorCode, "SUPERSEDED"),
                or(
                  and(
                    isNotNull(tasks.completedAt),
                    sql`julianday(${tasks.completedAt})<julianday('now')-15.0/1440`,
                  ),
                  and(
                    isNull(tasks.completedAt),
                    isNull(tasks.acceptedAt),
                    isNull(tasks.embedding),
                    eq(tasks.lastErrorCode, "VECTORIZE_WRITE_FAILED"),
                  ),
                ),
                or(
                  isNull(tasks.verifiedAt),
                  sql`julianday(${tasks.verifiedAt})<julianday('now')-${SCENE_INDEX_VERIFY_INTERVAL_MS}/86400000.0`,
                ),
              ),
            )
            .orderBy(
              sql`coalesce(${tasks.verifiedAt},${tasks.completedAt})`,
              tasks.id,
            )
            .limit(limit);
        },
        async enqueueRepair({
          dimensions,
          videoId,
          missingVectorIds,
          dedupeKey,
        }) {
          const message = buildJobMessage(JOB_REINDEX_VIDEO_TRANSCRIPT, {
            video_id: videoId,
          });
          const inserted = await db
            .insert(externalTasks)
            .select(
              db
                .select(
                  insertSelectValues(externalTasks, {
                    kind: "sqs_job",
                    payload: { message },
                    dedupeKey,
                  }),
                )
                .from(sql`json_each('[0]')`)
                .where(
                  exists(
                    db
                      .select({ id: scenes.id })
                      .from(scenes)
                      .where(
                        and(
                          eq(scenes.videoId, videoId),
                          eq(scenes.dimensions, dimensions),
                          inArray(
                            scenes.vectorId,
                            db
                              .select({ id: sql<string>`value` })
                              .from(
                                sql`json_each(${JSON.stringify(missingVectorIds)})`,
                              ),
                          ),
                        ),
                      ),
                  ),
                ),
            )
            .onConflictDoNothing({ target: externalTasks.dedupeKey })
            .returning({ id: externalTasks.id });
          return inserted.length;
        },
        async markVerified(taskIds) {
          await db
            .update(tasks)
            .set({ verifiedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` })
            .where(
              and(
                inArray(
                  tasks.id,
                  db
                    .select({ id: sql<string>`value` })
                    .from(sql`json_each(${JSON.stringify(taskIds)})`),
                ),
                or(
                  isNotNull(tasks.completedAt),
                  and(isNull(tasks.acceptedAt), isNull(tasks.embedding)),
                ),
              ),
            )
            .run();
        },
      },
    },
    dimensions,
    limit,
  );
}
