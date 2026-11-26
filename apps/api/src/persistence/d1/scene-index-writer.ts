import { EmbeddingCompatibilityError, assertEmbeddingFingerprint } from "../../lib/embedding-contract";
import {
  and,
  eq,
  ne,
  inArray,
  exists,
  or,
  isNull,
  notExists,
  sql,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectFields,
  insertSelectValues,
  prepareD1Query,
  runD1Batch,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  scenes,
  videos,
  sceneIndexTasks,
  sceneIndexRuns,
  sceneStaging,
  mutationReceipts,
  videoIndexVersions,
  videoIndexHeads,
} from "../../db/schema/sqlite";
import {
  canonicalSceneVectorInput,
  sceneEvidenceType,
  sceneFinishAllowed,
  sceneIndexCompletionOutcome,
  scenePublishAllowed,
  sceneRunCurrent,
  sceneStageAllowed,
  validateSceneEmbedding,
  validateSceneIndexRun,
} from "../../domain/search/scene-index-policy";
import { sceneIndexDrizzleLogic as logic } from "../scene-index-policy-sql";
import type { D1Database } from "@cloudflare/workers-types";
import type {
  SceneEmbedding,
  SceneIndexRunInput,
  SceneIndexWriter,
} from "../contracts/scene-index";

export async function sceneVectorId(
  runId: string,
  scene: SceneEmbedding,
): Promise<string> {
  const canonical = canonicalSceneVectorInput(runId, scene);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(hash), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

/** Each DELETE addresses an immutable vector version, never a newer scene version. */
export function enqueueCurrentSceneDeletes(
  database: D1Database,
  videoId: number,
  token: string,
  dimensions?: number,
) {
  const db = createD1Connection(database);
  const vectorId = sql<string>`coalesce(${scenes.vectorId},${scenes.id})`;
  const query = db
    .insert(sceneIndexTasks)
    .select(
      db
        .select(
          insertSelectFields(sceneIndexTasks, {
            id: sql`'d:'||${scenes.dimensions}||':'||${vectorId}`,
            operation: sql`'delete'`,
            vectorId,
            sceneId: scenes.id,
            revision: scenes.revision,
            videoId: scenes.videoId,
            userId: videos.userId,
            dimensions: scenes.dimensions,
          }),
        )
        .from(scenes)
        .innerJoin(videos, eq(videos.id, scenes.videoId))
        .where(
          and(
            eq(scenes.videoId, videoId),
            dimensions === undefined
              ? undefined
              : eq(scenes.dimensions, dimensions),
            exists(
              db
                .select({ token: mutationReceipts.token })
                .from(mutationReceipts)
                .where(eq(mutationReceipts.token, token)),
            ),
          ),
        ),
    )
    .onConflictDoUpdate({
      target: sceneIndexTasks.id,
      set: {
        completedAt: null,
        availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      },
      setWhere: or(
        isNull(sceneIndexTasks.leaseToken),
        sql`julianday(${sceneIndexTasks.leaseUntil})<=julianday('now')`,
      ),
    });
  return prepareD1Query(database, query);
}

export function enqueueStagedSceneDeletes(
  database: D1Database,
  videoId: number,
  token: string,
  exceptRunId: string | null = null,
) {
  const db = createD1Connection(database);
  const query = db
    .insert(sceneIndexTasks)
    .select(
      db
        .select(
          insertSelectFields(sceneIndexTasks, {
            id: sql`'d:'||${sceneIndexRuns.dimensions}||':'||${sceneStaging.vectorId}`,
            operation: sql`'delete'`,
            vectorId: sceneStaging.vectorId,
            sceneId: sceneStaging.sceneId,
            revision: sceneIndexRuns.id,
            videoId: sceneIndexRuns.videoId,
            userId: sceneIndexRuns.userId,
            dimensions: sceneIndexRuns.dimensions,
          }),
        )
        .from(sceneStaging)
        .innerJoin(sceneIndexRuns, eq(sceneIndexRuns.id, sceneStaging.runId))
        .where(
          and(
            eq(sceneIndexRuns.videoId, videoId),
            exceptRunId === null
              ? undefined
              : ne(sceneIndexRuns.id, exceptRunId),
            exists(
              db
                .select({ token: mutationReceipts.token })
                .from(mutationReceipts)
                .where(eq(mutationReceipts.token, token)),
            ),
          ),
        ),
    )
    .onConflictDoUpdate({
      target: sceneIndexTasks.id,
      set: {
        completedAt: null,
        availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      },
      setWhere: or(
        isNull(sceneIndexTasks.leaseToken),
        sql`julianday(${sceneIndexTasks.leaseUntil})<=julianday('now')`,
      ),
    });
  return prepareD1Query(database, query);
}

export function createD1SceneIndexWriter(
  database: D1Database,
  fingerprint?: string,
  identity?: string,
  expectedDimensions?: 768 | 1536,
): SceneIndexWriter {
  const db = createD1Connection(database),
    r = sceneIndexRuns,
    s = sceneStaging,
    t = sceneIndexTasks,
    versions = videoIndexVersions,
    heads = videoIndexHeads,
    receipts = mutationReceipts;
  const gate = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  const current = (userId: string) =>
    sceneRunCurrent(
      {
        owner: and(eq(r.userId, userId), eq(videos.userId, r.userId), fingerprint ? eq(r.embeddingFingerprint, fingerprint) : undefined)!,
        source: eq(versions.revision, r.sourceRevision),
        head: and(
          eq(heads.runId, r.id),
          eq(heads.videoId, r.videoId),
          eq(heads.dimensions, r.dimensions),
        )!,
      },
      logic,
    );
  const runQuery = () =>
    db
      .select({ id: r.id })
      .from(r)
      .innerJoin(videos, eq(videos.id, r.videoId))
      .innerJoin(versions, eq(versions.videoId, videos.id))
      .innerJoin(
        heads,
        and(eq(heads.videoId, videos.id), eq(heads.dimensions, r.dimensions)),
      );
  return {
    async readSource(videoId, userId) {
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
              .where(and(eq(videos.id, videoId), eq(videos.userId, userId))),
          )
          .onConflictDoNothing({ target: versions.videoId }),
        db
          .select({
            videoId: videos.id,
            userId: videos.userId,
            fileKey: videos.file,
            transcript: videos.transcript,
            status: videos.status,
            sourceRevision: versions.revision,
          })
          .from(videos)
          .innerJoin(versions, eq(versions.videoId, videos.id))
          .where(and(eq(videos.id, videoId), eq(videos.userId, userId))),
      ]);
      const row = result[1][0];
      return row
        ? {
            ...row,
            fileKey: row.fileKey ?? "",
            transcript: row.transcript ?? "",
          }
        : null;
    },
    async start(input: SceneIndexRunInput) {
      validateSceneIndexRun(input);
      if (fingerprint) assertEmbeddingFingerprint(input.embeddingFingerprint, fingerprint);
      if (expectedDimensions !== undefined && input.dimensions !== expectedDimensions) throw new EmbeddingCompatibilityError();
      const token = crypto.randomUUID();
      const result = await db.batch([
        db
          .insert(r)
          .select(
            db
              .select(
                insertSelectFields(r, {
                  id: sql`${input.runId}`,
                  videoId: videos.id,
                  userId: videos.userId,
                  sourceRevision: versions.revision,
                  dimensions: sql`${input.dimensions}`,
                  embeddingIdentity: sql`${identity ?? null}`,
                  embeddingFingerprint: sql`${input.embeddingFingerprint ?? null}`,
                  expectedScenes: sql`${input.expectedScenes}`,
                }),
              )
              .from(videos)
              .innerJoin(versions, eq(versions.videoId, videos.id))
              .where(
                and(
                  eq(videos.id, input.videoId),
                  eq(videos.userId, input.userId),
                  eq(versions.revision, input.sourceRevision),
                ),
              ),
          )
          .onConflictDoNothing({ target: r.id }),
        db.insert(receipts).select(
          db
            .select(
              insertSelectValues(receipts, {
                token,
                kind: "scene_start",
                resourceId: sql`${r.videoId}`,
              }),
            )
            .from(r)
            .where(and(eq(r.id, input.runId), sql`changes()=1`)),
        ),
        // Supersede only this dimension; 768d and 1536d heads remain independent.
        db
          .insert(t)
          .select(
            db
              .select(
                insertSelectFields(t, {
                  id: sql`'d:'||${r.dimensions}||':'||${s.vectorId}`,
                  operation: sql`'delete'`,
                  vectorId: s.vectorId,
                  sceneId: s.sceneId,
                  revision: r.id,
                  videoId: r.videoId,
                  userId: r.userId,
                  dimensions: r.dimensions,
                }),
              )
              .from(s)
              .innerJoin(r, eq(r.id, s.runId))
              .where(
                and(
                  eq(r.videoId, input.videoId),
                  eq(r.dimensions, input.dimensions),
                  ne(r.id, input.runId),
                  gate(token),
                ),
              ),
          )
          .onConflictDoUpdate({
            target: t.id,
            set: {
              completedAt: null,
              availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
            },
          }),
        db
          .insert(heads)
          .select(
            db
              .select(
                insertSelectValues(heads, {
                  videoId: input.videoId,
                  dimensions: input.dimensions,
                  runId: input.runId,
                }),
              )
              .from(receipts)
              .where(eq(receipts.token, token)),
          )
          .onConflictDoUpdate({
            target: [heads.videoId, heads.dimensions],
            set: { runId: sql`excluded.run_id` },
          }),
        db.delete(s).where(
          and(
            inArray(
              s.runId,
              db
                .select({ id: r.id })
                .from(r)
                .where(
                  and(
                    eq(r.videoId, input.videoId),
                    eq(r.dimensions, input.dimensions),
                    ne(r.id, input.runId),
                    eq(r.status, "staging"),
                  ),
                ),
            ),
            gate(token),
          ),
        ),
        runQuery().where(
          and(
            eq(r.id, input.runId),
            current(input.userId),
            eq(r.videoId, input.videoId),
            eq(r.dimensions, input.dimensions),
            eq(r.expectedScenes, input.expectedScenes),
            fingerprint ? eq(r.embeddingFingerprint, fingerprint) : undefined,
            eq(r.sourceRevision, input.sourceRevision),
          ),
        ),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      return result[5].length > 0;
    },
    async stage(runId, userId, input) {
      if (input.length > 20)
        throw new Error("Stage at most 20 scenes per request");
      const run = await db
        .select({ dimensions: r.dimensions, videoId: r.videoId, embeddingFingerprint: r.embeddingFingerprint })
        .from(r)
        .where(and(eq(r.id, runId), eq(r.userId, userId)))
        .get();
      if (!run) return false;
      if (fingerprint) assertEmbeddingFingerprint(run.embeddingFingerprint, fingerprint);
      if (expectedDimensions !== undefined && run.dimensions !== expectedDimensions) throw new EmbeddingCompatibilityError();
      const ids = new Set<string>();
      let size = 0;
      const encoded = [];
      for (const scene of input) {
        validateSceneEmbedding(scene, run.dimensions, {
          idFits: !scene.id || new TextEncoder().encode(scene.id).length <= 64,
          duplicate: ids.has(scene.id),
        });
        ids.add(scene.id);
        size += new TextEncoder().encode(JSON.stringify(scene)).length;
        if (size > 1_000_000)
          throw new Error("Scene staging payload is too large");
        encoded.push({ scene, vectorId: await sceneVectorId(runId, scene) });
      }
      const token = crypto.randomUUID();
      const statements: D1Query[] = [
        db.insert(receipts).select(
          db
            .select(
              insertSelectValues(receipts, {
                token,
                kind: "scene_stage",
                resourceId: sql`${r.videoId}`,
              }),
            )
            .from(r)
            .innerJoin(videos, eq(videos.id, r.videoId))
            .innerJoin(versions, eq(versions.videoId, videos.id))
            .innerJoin(
              heads,
              and(
                eq(heads.videoId, videos.id),
                eq(heads.dimensions, r.dimensions),
              ),
            )
            .where(
              and(
                eq(r.id, runId),
                sceneStageAllowed(
                  current(userId),
                  eq(r.status, "staging"),
                  logic,
                ),
              ),
            ),
        ),
      ];
      for (const { scene, vectorId } of encoded) {
        statements.push(
          db
            .insert(s)
            .select(
              db
                .select(
                  insertSelectValues(s, {
                    runId,
                    sceneId: scene.id,
                    vectorId,
                    content: scene.content,
                    startTime: scene.startTime,
                    endTime: scene.endTime,
                    evidenceType: sceneEvidenceType(scene),
                  }),
                )
                .from(receipts)
                .where(eq(receipts.token, token)),
            )
            .onConflictDoUpdate({
              target: [s.runId, s.sceneId],
              set: {
                vectorId: sql`CASE WHEN ${s.vectorId}=excluded.vector_id THEN ${s.vectorId} ELSE NULL END`,
              },
            }),
          db
            .insert(t)
            .select(
              db
                .select(
                  insertSelectValues(t, {
                    id: `u:${run.dimensions}:${vectorId}`,
                    operation: "upsert",
                    vectorId,
                    sceneId: scene.id,
                    revision: runId,
                    videoId: run.videoId,
                    userId,
                    dimensions: run.dimensions,
                    embedding: scene.embedding,
                  }),
                )
                .from(receipts)
                .where(eq(receipts.token, token)),
            )
            .onConflictDoNothing({ target: t.id }),
        );
      }
      statements.push(
        db
          .select({ token: receipts.token })
          .from(receipts)
          .where(eq(receipts.token, token)),
        db.delete(receipts).where(eq(receipts.token, token)),
      );
      const result = await runD1Batch(database, statements);
      return result[result.length - 2].results.length > 0;
    },
    async publish(runId, userId) {
      const run = await db
        .select({ videoId: r.videoId, dimensions: r.dimensions, embeddingFingerprint: r.embeddingFingerprint })
        .from(r)
        .where(and(eq(r.id, runId), eq(r.userId, userId)))
        .get();
      if (!run) return false;
      if (fingerprint) assertEmbeddingFingerprint(run.embeddingFingerprint, fingerprint);
      if (expectedDimensions !== undefined && run.dimensions !== expectedDimensions) throw new EmbeddingCompatibilityError();
      const token = crypto.randomUUID(),
        count = db
          .select({ count: sql<number>`count(*)` })
          .from(s)
          .where(eq(s.runId, r.id));
      const pending = db
        .select({ count: sql<number>`count(*)` })
        .from(t)
        .where(
          and(
            eq(t.operation, "upsert"),
            eq(t.revision, r.id),
            eq(t.videoId, r.videoId),
            eq(t.dimensions, r.dimensions),
            or(isNull(t.acceptedAt), isNull(t.completedAt)),
          ),
        );
      const result = await runD1Batch(database, [
        db.insert(receipts).select(
          db
            .select(
              insertSelectValues(receipts, {
                token,
                kind: "scene_publish",
                resourceId: sql`${r.videoId}`,
              }),
            )
            .from(r)
            .innerJoin(videos, eq(videos.id, r.videoId))
            .innerJoin(versions, eq(versions.videoId, videos.id))
            .innerJoin(
              heads,
              and(
                eq(heads.videoId, videos.id),
                eq(heads.dimensions, r.dimensions),
              ),
            )
            .where(
              and(
                eq(r.id, runId),
                scenePublishAllowed(
                  current(userId),
                  eq(r.status, "staging"),
                  eq(r.expectedScenes, count),
                  logic,
                ),
              ),
            ),
        ),
        enqueueCurrentSceneDeletes(
          database,
          run.videoId,
          token,
          run.dimensions,
        ),
        db
          .delete(scenes)
          .where(
            and(
              eq(scenes.videoId, run.videoId),
              eq(scenes.dimensions, run.dimensions),
              gate(token),
            ),
          ),
        db.insert(scenes).select(
          db
            .select(
              insertSelectFields(scenes, {
                id: s.sceneId,
                videoId: r.videoId,
                content: s.content,
                startTime: s.startTime,
                endTime: s.endTime,
                evidenceType: s.evidenceType,
                dimensions: r.dimensions,
                revision: r.id,
                vectorId: s.vectorId,
              }),
            )
            .from(s)
            .innerJoin(r, eq(r.id, s.runId))
            .where(and(eq(r.id, runId), gate(token))),
        ),
        db
          .update(r)
          .set({ status: "published", pendingVectors: sql`${pending}` })
          .where(and(eq(r.id, runId), gate(token))),
        db.delete(s).where(and(eq(s.runId, runId), gate(token))),
        runQuery().where(
          and(eq(r.id, runId), current(userId), eq(r.status, "published")),
        ),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      return result[6].results.length > 0;
    },
  };
}
/** Trusted lookup; readSource rechecks ownership before returning source data. */
export async function readD1WorkerSceneSource(
  database: D1Database,
  videoId: number,
) {
  const row = await createD1Connection(database)
    .select({ userId: videos.userId })
    .from(videos)
    .where(eq(videos.id, videoId))
    .get();
  return row
    ? createD1SceneIndexWriter(database).readSource(videoId, row.userId)
    : null;
}
/** ANN visibility must be verified before completing the current published run. */
export async function finishD1WorkerSceneIndex(
  database: D1Database,
  input: import("../contracts/scene-index").FinishSceneIndexInput,
  fingerprint?: string,
): Promise<import("../contracts/scene-index").FinishSceneIndexResult> {
  const db = createD1Connection(database),
    r = sceneIndexRuns,
    t = sceneIndexTasks,
    versions = videoIndexVersions,
    heads = videoIndexHeads;
  const current = and(
    eq(videos.id, input.videoId),
    eq(videos.userId, input.userId),
    eq(versions.revision, input.sourceRevision),
    eq(videos.file, input.fileKey),
  );
  const published = exists(
    db
      .select({ id: r.id })
      .from(heads)
      .innerJoin(r, eq(r.id, heads.runId))
      .where(
        and(
          eq(heads.videoId, videos.id),
          eq(heads.dimensions, input.dimensions),
          eq(r.status, "published"),
          fingerprint ? eq(r.embeddingFingerprint, fingerprint) : undefined,
          eq(r.sourceRevision, versions.revision),
          eq(r.userId, videos.userId),
        ),
      ),
  );
  const finish = sceneFinishAllowed(
    eq(videos.status, "indexing"),
    exists(
      db
        .select({ id: versions.videoId })
        .from(versions)
        .where(and(eq(versions.videoId, videos.id), current, published)),
    ),
    notExists(
      db
        .select({ id: scenes.id })
        .from(scenes)
        .leftJoin(
          t,
          eq(t.id, sql`'u:'||${scenes.dimensions}||':'||${scenes.vectorId}`),
        )
        .where(
          and(
            eq(scenes.videoId, videos.id),
            eq(scenes.dimensions, input.dimensions),
            or(isNull(t.id), isNull(t.acceptedAt), isNull(t.completedAt)),
          ),
        ),
    ),
    logic,
  );
  const result = await db.batch([
    db
      .update(videos)
      .set({ status: "completed", errorMessage: "" })
      .where(finish),
    db
      .select({ status: videos.status, published })
      .from(videos)
      .innerJoin(versions, eq(versions.videoId, videos.id))
      .where(current),
  ]);
  const row = result[1][0];
  return sceneIndexCompletionOutcome(
    row ? { status: row.status, published: Boolean(row.published) } : undefined,
  );
}
