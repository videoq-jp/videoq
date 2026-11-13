import type {D1Database} from "@cloudflare/workers-types";
import type { SceneIndexTask, SceneIndexTaskRepository } from "../contracts/scene-index";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
// A vector ID is immutable for a run/scene/content triple. Superseded runs can
// never become heads again, so an obsolete ID cannot later name current content.
const DESIRED = `EXISTS(SELECT 1 FROM scenes s JOIN videos v ON v.id=s.video_id
  WHERE s.id=t.scene_id AND s.dimensions=t.dimensions AND s.revision=t.revision
    AND coalesce(s.vector_id,s.id)=t.vector_id AND v.id=t.video_id AND v.user_id=t.user_id)
  OR EXISTS(SELECT 1 FROM scene_staging s JOIN scene_index_runs r ON r.id=s.run_id
    JOIN videos v ON v.id=r.video_id JOIN video_index_versions versions ON versions.video_id=v.id
    JOIN video_index_heads heads ON heads.video_id=v.id AND heads.dimensions=r.dimensions
    WHERE s.scene_id=t.scene_id AND s.vector_id=t.vector_id AND r.id=t.revision AND r.dimensions=t.dimensions
      AND r.video_id=t.video_id AND r.user_id=t.user_id AND v.user_id=t.user_id
      AND r.source_revision=versions.revision AND heads.run_id=r.id AND r.status='staging')`;
const OWNS = "id=? AND lease_token=? AND completed_at IS NULL AND julianday(lease_until)>julianday('now')";

export function createD1SceneIndexTaskRepository(database: D1Database): SceneIndexTaskRepository {
  return {
    async claim() {
      const row = await database.prepare(`UPDATE scene_index_tasks SET lease_token=?,
        lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+300 seconds'),attempts=attempts+1
        WHERE id=(SELECT id FROM scene_index_tasks WHERE completed_at IS NULL
          AND julianday(available_at)<=julianday('now') AND (lease_token IS NULL OR julianday(lease_until)<=julianday('now'))
          ORDER BY available_at,created_at,id LIMIT 1) RETURNING *`).bind(crypto.randomUUID()).first<{
          id: string; operation: "upsert" | "delete"; vector_id: string; scene_id: string; revision: string;
          video_id: number; user_id: string; dimensions: 768 | 1536; embedding: string | null; lease_token: string;
        }>();
      return row ? { id: row.id, operation: row.operation, vectorId: row.vector_id, sceneId: row.scene_id, revision: row.revision,
        videoId: row.video_id, userId: row.user_id, dimensions: row.dimensions,
        embedding: row.embedding === null ? null : JSON.parse(row.embedding) as number[], leaseToken: row.lease_token } : null;
    },
    async isDesired(taskId) {
      return Boolean((await database.prepare(`SELECT (${DESIRED}) AS desired FROM scene_index_tasks t WHERE t.id=?`)
        .bind(taskId).first<{ desired: number }>())?.desired);
    },
    async complete(task: SceneIndexTask) {
      const rows = await database.prepare(`UPDATE scene_index_tasks SET completed_at=${NOW},embedding=NULL,
        lease_token=NULL,lease_until=NULL,last_error_code='' WHERE ${OWNS} RETURNING id`).bind(task.id, task.leaseToken).all();
      return rows.results.length > 0;
    },
    async retry(task, code) {
      const rows = await database.prepare(`UPDATE scene_index_tasks SET lease_token=NULL,lease_until=NULL,last_error_code=?,
        available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||min(3600,5*(1 << min(attempts,10)))||' seconds')
        WHERE ${OWNS} RETURNING id`).bind(code, task.id, task.leaseToken).all();
      return rows.results.length > 0;
    },
    async reconcileObsolete(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid index reconciliation limit");
      const obsolete = (await database.prepare(`SELECT t.id FROM scene_index_tasks t
        WHERE t.operation='upsert' AND t.completed_at IS NOT NULL AND t.last_error_code<>'SUPERSEDED'
          AND NOT (${DESIRED}) ORDER BY t.completed_at,t.id LIMIT ?`).bind(limit).all<{ id: string }>()).results;
      if (!obsolete.length) return 0;
      const ids = JSON.stringify(obsolete.map(row => row.id));
      const result = await database.batch([
        database.prepare(`INSERT INTO scene_index_tasks(id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions)
          SELECT 'd:'||t.dimensions||':'||t.vector_id,'delete',t.vector_id,t.scene_id,t.revision,t.video_id,t.user_id,t.dimensions
          FROM scene_index_tasks t WHERE t.id IN(SELECT value FROM json_each(?)) AND NOT (${DESIRED})
          ON CONFLICT(id) DO UPDATE SET completed_at=NULL,available_at=${NOW}
            WHERE scene_index_tasks.lease_token IS NULL OR julianday(scene_index_tasks.lease_until)<=julianday('now')
          RETURNING id`).bind(ids),
        database.prepare(`UPDATE scene_index_tasks AS t SET last_error_code='SUPERSEDED'
          WHERE t.id IN(SELECT value FROM json_each(?)) AND NOT (${DESIRED}) AND EXISTS(
            SELECT 1 FROM scene_index_tasks d WHERE d.id='d:'||t.dimensions||':'||t.vector_id)`).bind(ids),
      ]);
      return result[0].results.length;
    },
  };
}
