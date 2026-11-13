import type {D1Database} from "@cloudflare/workers-types";
import type { SceneEmbedding, SceneIndexRunInput, SceneIndexWriter } from "../contracts/scene-index";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const RUN_IS_CURRENT = `r.user_id=? AND v.user_id=r.user_id AND versions.revision=r.source_revision
  AND heads.run_id=r.id AND heads.video_id=r.video_id AND heads.dimensions=r.dimensions`;
const RUN_JOINS = `scene_index_runs r JOIN videos v ON v.id=r.video_id
  JOIN video_index_versions versions ON versions.video_id=v.id
  JOIN video_index_heads heads ON heads.video_id=v.id AND heads.dimensions=r.dimensions`;

export async function sceneVectorId(runId: string, scene: SceneEmbedding): Promise<string> {
  const canonical = JSON.stringify([runId, scene.id, scene.content, scene.startTime, scene.endTime, scene.evidenceType ?? "transcript", scene.embedding]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

/** Each DELETE addresses an immutable vector version, never a newer scene version. */
export function enqueueCurrentSceneDeletes(database: D1Database, videoId: number, token: string, dimensions?: number) {
  return database.prepare(`INSERT INTO scene_index_tasks
    (id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions)
    SELECT 'd:'||s.dimensions||':'||coalesce(s.vector_id,s.id),'delete',coalesce(s.vector_id,s.id),s.id,s.revision,s.video_id,v.user_id,s.dimensions
    FROM scenes s JOIN videos v ON v.id=s.video_id
    WHERE s.video_id=? AND (? IS NULL OR s.dimensions=?) AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)
    ON CONFLICT(id) DO UPDATE SET completed_at=NULL,available_at=${NOW}
      WHERE scene_index_tasks.lease_token IS NULL OR julianday(scene_index_tasks.lease_until)<=julianday('now')`)
    .bind(videoId, dimensions ?? null, dimensions ?? null, token);
}

export function enqueueStagedSceneDeletes(database: D1Database, videoId: number, token: string, exceptRunId: string | null = null) {
  return database.prepare(`INSERT INTO scene_index_tasks
    (id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions)
    SELECT 'd:'||r.dimensions||':'||s.vector_id,'delete',s.vector_id,s.scene_id,r.id,r.video_id,r.user_id,r.dimensions
    FROM scene_staging s JOIN scene_index_runs r ON r.id=s.run_id
    WHERE r.video_id=? AND (? IS NULL OR r.id<>?) AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)
    ON CONFLICT(id) DO UPDATE SET completed_at=NULL,available_at=${NOW}
      WHERE scene_index_tasks.lease_token IS NULL OR julianday(scene_index_tasks.lease_until)<=julianday('now')`)
    .bind(videoId, exceptRunId, exceptRunId, token);
}

export function createD1SceneIndexWriter(database: D1Database): SceneIndexWriter {
  return {
    async readSource(videoId, userId) {
      const result = await database.batch<Record<string, unknown>>([
        database.prepare(`INSERT INTO video_index_versions(video_id,revision) SELECT id,? FROM videos WHERE id=? AND user_id=?
          ON CONFLICT(video_id) DO NOTHING`).bind(crypto.randomUUID(), videoId, userId),
        database.prepare(`SELECT v.id AS videoId,v.user_id AS userId,v.file AS fileKey,v.transcript,v.status,versions.revision AS sourceRevision
          FROM videos v JOIN video_index_versions versions ON versions.video_id=v.id WHERE v.id=? AND v.user_id=?`).bind(videoId, userId),
      ]);
      const row = result[1].results[0];
      return row ? { videoId: Number(row.videoId), userId: String(row.userId), sourceRevision: String(row.sourceRevision),
        fileKey: typeof row.fileKey === "string" ? row.fileKey : "", transcript: typeof row.transcript === "string" ? row.transcript : "", status: String(row.status) } : null;
    },
    async start(input: SceneIndexRunInput) {
      if (![768, 1536].includes(input.dimensions) || !Number.isSafeInteger(input.expectedScenes) || input.expectedScenes < 0 ||
          !input.runId || input.runId.length > 128) throw new Error("Invalid scene index run");
      const token = crypto.randomUUID();
      const result = await database.batch<Record<string, unknown>>([
        database.prepare(`INSERT INTO scene_index_runs(id,video_id,user_id,source_revision,dimensions,expected_scenes)
          SELECT ?,v.id,v.user_id,versions.revision,?,? FROM videos v JOIN video_index_versions versions ON versions.video_id=v.id
          WHERE v.id=? AND v.user_id=? AND versions.revision=? ON CONFLICT(id) DO NOTHING`)
          .bind(input.runId, input.dimensions, input.expectedScenes, input.videoId, input.userId, input.sourceRevision),
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'scene_start',video_id FROM scene_index_runs
          WHERE id=? AND changes()=1`).bind(token, input.runId),
        // Supersede staging only within this dimension's head. A 768d run must
        // not invalidate a concurrently prepared 1536d run.
        database.prepare(`INSERT INTO scene_index_tasks(id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions)
          SELECT 'd:'||r.dimensions||':'||s.vector_id,'delete',s.vector_id,s.scene_id,r.id,r.video_id,r.user_id,r.dimensions
          FROM scene_staging s JOIN scene_index_runs r ON r.id=s.run_id
          WHERE r.video_id=? AND r.dimensions=? AND r.id<>? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)
          ON CONFLICT(id) DO UPDATE SET completed_at=NULL,available_at=${NOW}`)
          .bind(input.videoId, input.dimensions, input.runId, token),
        database.prepare(`INSERT INTO video_index_heads(video_id,dimensions,run_id)
          SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)
          ON CONFLICT(video_id,dimensions) DO UPDATE SET run_id=excluded.run_id`)
          .bind(input.videoId, input.dimensions, input.runId, token),
        database.prepare(`DELETE FROM scene_staging WHERE run_id IN(SELECT id FROM scene_index_runs WHERE video_id=? AND dimensions=? AND id<>? AND status='staging')
          AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(input.videoId, input.dimensions, input.runId, token),
        database.prepare(`SELECT r.id FROM ${RUN_JOINS} WHERE r.id=? AND ${RUN_IS_CURRENT}
          AND r.video_id=? AND r.dimensions=? AND r.expected_scenes=? AND r.source_revision=?`)
          .bind(input.runId, input.userId, input.videoId, input.dimensions, input.expectedScenes, input.sourceRevision),
        database.prepare("DELETE FROM mutation_receipts WHERE token=?").bind(token),
      ]);
      return result[5].results.length > 0;
    },
    async stage(runId, userId, input) {
      if (input.length > 20) throw new Error("Stage at most 20 scenes per request");
      const run = await database.prepare("SELECT dimensions,video_id FROM scene_index_runs WHERE id=? AND user_id=?")
        .bind(runId, userId).first<{ dimensions: number; video_id: number }>();
      if (!run) return false;
      const ids = new Set<string>();
      let size = 0;
      const encoded = [];
      for (const scene of input) {
        if (!scene.id || new TextEncoder().encode(scene.id).length > 64 || ids.has(scene.id) ||
            typeof scene.content !== "string" || typeof scene.startTime !== "string" || typeof scene.endTime !== "string" ||
            scene.evidenceType !== undefined && !["transcript", "visual"].includes(scene.evidenceType) ||
            !Array.isArray(scene.embedding) || scene.embedding.length !== run.dimensions || !scene.embedding.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
            !scene.embedding.some(value => Math.fround(value) !== 0)) throw new Error("Invalid scene embedding");
        ids.add(scene.id);
        const embedding = JSON.stringify(scene.embedding);
        size += new TextEncoder().encode(JSON.stringify(scene)).length;
        if (size > 1_000_000) throw new Error("Scene staging payload is too large");
        encoded.push({ scene, embedding, vectorId: await sceneVectorId(runId, scene) });
      }
      const token = crypto.randomUUID();
      const statements = [database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id)
        SELECT ?,'scene_stage',r.video_id FROM ${RUN_JOINS} WHERE r.id=? AND ${RUN_IS_CURRENT} AND r.status='staging'`)
        .bind(token, runId, userId)];
      for (const { scene, embedding, vectorId } of encoded) {
        statements.push(database.prepare(`INSERT INTO scene_staging(run_id,scene_id,vector_id,content,start_time,end_time,evidence_type)
          SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)
          ON CONFLICT(run_id,scene_id) DO UPDATE SET vector_id=CASE
            WHEN scene_staging.vector_id=excluded.vector_id THEN scene_staging.vector_id ELSE NULL END`)
          .bind(runId, scene.id, vectorId, scene.content, scene.startTime, scene.endTime, scene.evidenceType ?? "transcript", token));
        statements.push(database.prepare(`INSERT INTO scene_index_tasks(id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions,embedding)
          SELECT ?,'upsert',?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) ON CONFLICT(id) DO NOTHING`)
          .bind(`u:${run.dimensions}:${vectorId}`, vectorId, scene.id, runId, run.video_id, userId, run.dimensions, embedding, token));
      }
      statements.push(database.prepare("SELECT token FROM mutation_receipts WHERE token=?").bind(token));
      statements.push(database.prepare("DELETE FROM mutation_receipts WHERE token=?").bind(token));
      const result = await database.batch(statements);
      return result[result.length - 2].results.length > 0;
    },
    async publish(runId, userId) {
      const run = await database.prepare("SELECT video_id,dimensions FROM scene_index_runs WHERE id=? AND user_id=?")
        .bind(runId, userId).first<{ video_id: number; dimensions: number }>();
      if (!run) return false;
      const token = crypto.randomUUID();
      const result = await database.batch([
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id)
          SELECT ?,'scene_publish',r.video_id FROM ${RUN_JOINS} WHERE r.id=? AND ${RUN_IS_CURRENT} AND r.status='staging'
            AND r.expected_scenes=(SELECT count(*) FROM scene_staging WHERE run_id=r.id)`)
          .bind(token, runId, userId),
        enqueueCurrentSceneDeletes(database, run.video_id, token, run.dimensions),
        database.prepare("DELETE FROM scenes WHERE video_id=? AND dimensions=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)")
          .bind(run.video_id, run.dimensions, token),
        database.prepare(`INSERT INTO scenes(id,video_id,content,start_time,end_time,evidence_type,dimensions,revision,vector_id)
          SELECT s.scene_id,r.video_id,s.content,s.start_time,s.end_time,s.evidence_type,r.dimensions,r.id,s.vector_id
          FROM scene_staging s JOIN scene_index_runs r ON r.id=s.run_id WHERE r.id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`)
          .bind(runId, token),
        database.prepare("UPDATE scene_index_runs SET status='published' WHERE id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)")
          .bind(runId, token),
        database.prepare("DELETE FROM scene_staging WHERE run_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)").bind(runId, token),
        database.prepare(`SELECT r.id FROM ${RUN_JOINS} WHERE r.id=? AND ${RUN_IS_CURRENT} AND r.status='published'`).bind(runId, userId),
        database.prepare("DELETE FROM mutation_receipts WHERE token=?").bind(token),
      ]);
      return result[6].results.length > 0;
    },
  };
}

/** Trusted worker lookup; readSource rechecks ownership after this lookup. */
export async function readD1WorkerSceneSource(database: D1Database, videoId: number) {
  const row = await database.prepare("SELECT user_id FROM videos WHERE id=?").bind(videoId).first<{ user_id: string }>();
  return row ? createD1SceneIndexWriter(database).readSource(videoId, row.user_id) : null;
}

/** Completion waits for durable Vectorize delivery. A retry can finish the same
 * published run without regenerating embeddings or replacing its head. */
export async function finishD1WorkerSceneIndex(
  database: D1Database, input: import("../contracts/scene-index").FinishSceneIndexInput,
): Promise<import("../contracts/scene-index").FinishSceneIndexResult> {
  const current = `v.id=? AND v.user_id=? AND versions.revision=? AND v.file=?`;
  const published = `EXISTS(SELECT 1 FROM video_index_heads h JOIN scene_index_runs r ON r.id=h.run_id
    WHERE h.video_id=v.id AND h.dimensions=? AND r.status='published' AND r.source_revision=versions.revision AND r.user_id=v.user_id)`;
  const result = await database.batch<{ status: string; published: number }>([
    database.prepare(`UPDATE videos AS v SET status='completed',error_message=''
      WHERE v.status='indexing' AND EXISTS(SELECT 1 FROM video_index_versions versions
        WHERE versions.video_id=v.id AND ${current} AND ${published})
      AND NOT EXISTS(SELECT 1 FROM scenes s LEFT JOIN scene_index_tasks t ON t.id='u:'||s.dimensions||':'||s.vector_id
        WHERE s.video_id=v.id AND s.dimensions=? AND (t.id IS NULL OR t.completed_at IS NULL))`)
      .bind(input.videoId, input.userId, input.sourceRevision, input.fileKey, input.dimensions, input.dimensions),
    database.prepare(`SELECT v.status,${published} AS published FROM videos v JOIN video_index_versions versions ON versions.video_id=v.id
      WHERE ${current}`).bind(input.dimensions, input.videoId, input.userId, input.sourceRevision, input.fileKey),
  ]);
  const row = result[1].results[0];
  if (!row || !["indexing", "completed"].includes(row.status)) return "stale";
  if (row.status === "completed") return "completed";
  return row.published ? "pending" : "missing";
}
