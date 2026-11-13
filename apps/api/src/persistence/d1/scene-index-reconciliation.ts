import type { Vectorize } from "@cloudflare/workers-types";
import { buildJobMessage, JOB_REINDEX_VIDEO_TRANSCRIPT } from "../../lib/job-message";
import { SCENE_INDEX_VERIFY_INTERVAL_MS } from "../contracts/scene-index";

/** Check a bounded page; old vector payloads are rebuilt from source, not kept in D1. */
export async function reconcileMissingSceneVectors(database: D1Database, index: Vectorize, dimensions: 768 | 1536, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid index verification limit");
  const due = (await database.prepare(`SELECT t.id,t.vector_id,t.video_id,versions.revision AS source_revision FROM scene_index_tasks t
    JOIN video_index_versions versions ON versions.video_id=t.video_id
    JOIN scenes s ON s.vector_id=t.vector_id AND s.dimensions=t.dimensions AND s.revision=t.revision
    WHERE t.operation='upsert' AND t.dimensions=? AND t.completed_at IS NOT NULL AND t.last_error_code<>'SUPERSEDED'
      AND julianday(t.completed_at)<julianday('now')-15.0/1440
      AND (t.verified_at IS NULL OR julianday(t.verified_at)<julianday('now')-?/86400000.0)
    ORDER BY coalesce(t.verified_at,t.completed_at),t.id LIMIT ?`)
    .bind(dimensions, SCENE_INDEX_VERIFY_INTERVAL_MS, limit).all<{ id: string; vector_id: string; video_id: number; source_revision: string }>()).results;
  if (!due.length) return { verified: 0, repairQueued: 0 };
  let existing: Set<string>;
  try { existing = new Set((await index.getByIds(due.map(task => task.vector_id))).map(vector => vector.id)); }
  catch { throw new Error("Vectorize index verification failed"); }
  const missing = due.filter(task => !existing.has(task.vector_id));
  let repairQueued = 0;
  for (const videoId of new Set(missing.map(task => task.video_id))) {
    const missingIds = JSON.stringify(missing.filter(task => task.video_id === videoId).map(task => task.vector_id));
    const message = buildJobMessage(JOB_REINDEX_VIDEO_TRANSCRIPT, { video_id: videoId });
    // A repair is a fresh job, bounded to one per video/profile/hour. Reusing a
    // completed job_id would be discarded by the worker's replay barrier.
    const revision = missing.find(task => task.video_id === videoId)!.source_revision;
    const key = `vector-repair:${dimensions}:${videoId}:${revision}:${Math.floor(Date.now() / SCENE_INDEX_VERIFY_INTERVAL_MS)}`;
    const inserted = await database.prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key)
      SELECT 'sqs_job',?,? WHERE EXISTS(SELECT 1 FROM scenes WHERE video_id=? AND dimensions=? AND vector_id IN(SELECT value FROM json_each(?)))
      ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`).bind(JSON.stringify({ message }), key, videoId, dimensions, missingIds).all();
    repairQueued += inserted.results.length;
  }
  await database.prepare(`UPDATE scene_index_tasks SET verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id IN(SELECT value FROM json_each(?)) AND completed_at IS NOT NULL`).bind(JSON.stringify(due.map(task => task.id))).run();
  return { verified: due.length, repairQueued };
}
