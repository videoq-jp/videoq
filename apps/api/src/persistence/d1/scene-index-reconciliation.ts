import type { Vectorize } from '@cloudflare/workers-types';
import { buildJobMessage, JOB_REINDEX_VIDEO_TRANSCRIPT } from '../../lib/job-message';
import { SCENE_INDEX_VERIFY_INTERVAL_MS } from '../contracts/scene-index';
import type { SceneVectorIdentity, SceneVectorVerificationTask } from '../contracts/scene-index-verification';
import { reconcileSceneVectors } from '../../features/maintenance/scene-index-service';

/** SQL retains source checks and the unique outbox insert; policy owns paging and repair selection. */
export async function reconcileMissingSceneVectors(database: D1Database, index: Vectorize, dimensions: 768 | 1536, limit = 50) {
  return reconcileSceneVectors({
    nowMs: Date.now,
    readVectors: async ids => {
      // Vectorize limits getByIds to 20 IDs. Return only after every batch succeeds.
      const vectors: SceneVectorIdentity[] = [];
      for (let offset = 0; offset < ids.length; offset += 20) {
        vectors.push(...await index.getByIds(ids.slice(offset, offset + 20)));
      }
      return vectors;
    },
    repository: {
      async due(dimensions, limit) {
        return (await database.prepare(`SELECT t.id,t.vector_id,t.video_id,t.user_id,t.scene_id,t.revision,
    t.completed_at IS NULL AS legacy_replay,versions.revision AS source_revision FROM scene_index_tasks t
    JOIN video_index_versions versions ON versions.video_id=t.video_id
    JOIN scenes s ON s.vector_id=t.vector_id AND s.dimensions=t.dimensions AND s.revision=t.revision
    WHERE t.operation='upsert' AND t.dimensions=? AND t.last_error_code<>'SUPERSEDED'
      AND ((t.completed_at IS NOT NULL AND julianday(t.completed_at)<julianday('now')-15.0/1440)
        OR (t.completed_at IS NULL AND t.accepted_at IS NULL AND t.embedding IS NULL AND t.last_error_code='VECTORIZE_WRITE_FAILED'))
      AND (t.verified_at IS NULL OR julianday(t.verified_at)<julianday('now')-?/86400000.0)
    ORDER BY coalesce(t.verified_at,t.completed_at),t.id LIMIT ?`)
    .bind(dimensions, SCENE_INDEX_VERIFY_INTERVAL_MS, limit).all<SceneVectorVerificationTask>()).results;
      },
      async enqueueRepair({ dimensions, videoId, missingVectorIds, dedupeKey }) {
        const message = buildJobMessage(JOB_REINDEX_VIDEO_TRANSCRIPT, { video_id: videoId });
        const inserted = await database.prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key)
          SELECT 'sqs_job',?,? WHERE EXISTS(SELECT 1 FROM scenes WHERE video_id=? AND dimensions=? AND vector_id IN(SELECT value FROM json_each(?)))
          ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`)
          .bind(JSON.stringify({ message }), dedupeKey, videoId, dimensions, JSON.stringify(missingVectorIds)).all();
        return inserted.results.length;
      },
      async markVerified(taskIds) {
        await database.prepare(`UPDATE scene_index_tasks SET verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id IN(SELECT value FROM json_each(?)) AND (completed_at IS NOT NULL OR accepted_at IS NULL AND embedding IS NULL)`)
          .bind(JSON.stringify(taskIds)).run();
      },
    },
  }, dimensions, limit);
}
