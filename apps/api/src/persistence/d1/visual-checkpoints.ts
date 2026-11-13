import { beginVisualObject } from "./visual-objects";
import type { VisualCheckpoints, VisualRun, VisualChunk } from "../contracts/visual-checkpoints";
const JOINS = "video_visual_runs r JOIN videos v ON v.id=r.video_id";
const CURRENT = "r.file_key=v.file AND v.source_type='uploaded'";
const PROJECTION = `r.video_id AS videoId,r.run_id AS runId,r.file_key AS fileKey,r.duration_ms AS durationMs,r.chunk_count AS chunkCount,r.status,r.publication_version AS publicationVersion`;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export function createD1VisualCheckpoints(database: D1Database): VisualCheckpoints {
  return {
    beginObject:(videoId,runId,version,index)=>beginVisualObject(database,videoId,runId,version,index),
    async load(videoId, runId) {
      return database.prepare(`SELECT ${PROJECTION} FROM ${JOINS} WHERE v.id=? AND ${CURRENT} AND (? IS NULL OR r.run_id=?)`)
        .bind(videoId,runId ?? null,runId ?? null).first<VisualRun>();
    },
    async initialize(videoId, fileKey, durationMs) {
      if (!Number.isSafeInteger(durationMs) || durationMs<=0 || durationMs>36_000_000) throw new Error("Invalid visual duration");
      const count = Math.ceil(durationMs/60_000);
      const runId = crypto.randomUUID();
      const token = crypto.randomUUID();
      const result = await database.batch<VisualRun>([
        database.prepare(`DELETE FROM video_visual_runs WHERE video_id=? AND file_key<>? AND EXISTS(SELECT 1 FROM videos WHERE id=? AND file=? AND source_type='uploaded')`)
          .bind(videoId,fileKey,videoId,fileKey),
        database.prepare(`INSERT INTO video_visual_runs(video_id,run_id,file_key,duration_ms,chunk_count)
          SELECT id,?,?,?,? FROM videos WHERE id=? AND file=? AND source_type='uploaded' ON CONFLICT(video_id) DO NOTHING`)
          .bind(runId,fileKey,durationMs,count,videoId,fileKey),
        database.prepare("INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'visual_plan',? WHERE changes()=1").bind(token,videoId),
        database.prepare(`INSERT INTO video_visual_chunks(run_id,chunk_index) SELECT ?,value FROM json_each(?) WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`)
          .bind(runId,JSON.stringify(Array.from({length:count},(_,i)=>i)),token),
        database.prepare(`SELECT ${PROJECTION} FROM ${JOINS} WHERE v.id=? AND v.file=? AND ${CURRENT}`).bind(videoId,fileKey),
        database.prepare("DELETE FROM mutation_receipts WHERE token=?").bind(token),
      ]);
      return result[4].results[0] ?? null;
    },
    async pending(runId) {
      const rows = await database.prepare(`SELECT c.chunk_index FROM video_visual_chunks c JOIN video_visual_runs r ON r.run_id=c.run_id
        JOIN videos v ON v.id=r.video_id WHERE r.run_id=? AND ${CURRENT} AND r.status<>'ready' AND c.frame_count IS NULL ORDER BY c.chunk_index`)
        .bind(runId).all<{chunk_index:number}>();
      return rows.results.map(r=>r.chunk_index);
    },
    async chunks(videoId,runId) {
      const results = await database.batch<VisualChunk>([
        database.prepare(`SELECT 1 FROM ${JOINS} WHERE v.id=? AND r.run_id=? AND ${CURRENT}`).bind(videoId,runId),
        database.prepare(`SELECT c.chunk_index AS "index",c.frame_count AS frameCount,c.object_version AS objectVersion
          FROM ${JOINS} JOIN video_visual_chunks c ON c.run_id=r.run_id WHERE v.id=? AND r.run_id=? AND ${CURRENT} ORDER BY c.chunk_index`)
          .bind(videoId,runId),
      ]);
      return results[0].results.length ? results[1].results : null;
    },
    async publishChunk(videoId,runId,index,frameCount,objectVersion) {
      if (!Number.isSafeInteger(frameCount) || frameCount<0 || frameCount>60 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(objectVersion)) throw new Error("Invalid visual checkpoint");
      const result = await database.batch<{objectVersion:string|null}>([
        database.prepare(`UPDATE video_visual_chunks SET frame_count=?,object_version=?,last_error='',updated_at=${NOW}
          WHERE run_id=? AND chunk_index=? AND frame_count IS NULL
          AND EXISTS(SELECT 1 FROM visual_object_attempts a WHERE a.id='c:'||? AND a.video_id=? AND a.run_id=? AND a.chunk_index=?
            AND a.status='pending' AND julianday(a.expires_at)>julianday('now')) AND EXISTS(SELECT 1 FROM ${JOINS} WHERE v.id=? AND r.run_id=? AND ${CURRENT} AND r.status<>'ready')`)
          .bind(frameCount,objectVersion,runId,index,objectVersion,videoId,runId,index,videoId,runId),
        database.prepare(`UPDATE visual_object_attempts SET status='published' WHERE id='c:'||? AND status='pending'
          AND EXISTS(SELECT 1 FROM video_visual_chunks c WHERE c.run_id=? AND c.chunk_index=? AND c.object_version=?)`)
          .bind(objectVersion,runId,index,objectVersion),
        database.prepare(`UPDATE video_visual_runs SET status='processing',last_error='' WHERE run_id=? AND status<>'ready'
          AND NOT EXISTS(SELECT 1 FROM video_visual_chunks WHERE run_id=? AND last_error<>'')
          AND EXISTS(SELECT 1 FROM video_visual_chunks WHERE run_id=? AND chunk_index=? AND object_version=?)
          AND EXISTS(SELECT 1 FROM videos v WHERE v.id=video_visual_runs.video_id AND v.file=video_visual_runs.file_key AND v.source_type='uploaded')`).bind(runId,runId,runId,index,objectVersion),
        database.prepare(`SELECT c.object_version AS objectVersion FROM ${JOINS} JOIN video_visual_chunks c ON c.run_id=r.run_id
          WHERE v.id=? AND r.run_id=? AND c.chunk_index=? AND ${CURRENT}`).bind(videoId,runId,index),
      ]);
      const row = result[3].results[0];
      return {current:Boolean(row),objectVersion:row?.objectVersion ?? null};
    },
    async ready(videoId,runId,objectVersion) {
      const result = await database.batch([
        database.prepare(`UPDATE video_visual_runs SET status='ready',publication_version=coalesce(publication_version,?),completed_at=coalesce(completed_at,${NOW}),last_error=''
          WHERE video_id=? AND run_id=? AND EXISTS(SELECT 1 FROM videos v WHERE v.id=video_visual_runs.video_id AND v.file=video_visual_runs.file_key AND v.source_type='uploaded')
            AND EXISTS(SELECT 1 FROM visual_object_attempts a WHERE a.id='m:'||? AND a.run_id=video_visual_runs.run_id
              AND (a.status='published' OR (a.status='pending' AND julianday(a.expires_at)>julianday('now'))))
            AND chunk_count=(SELECT count(*) FROM video_visual_chunks WHERE run_id=? AND frame_count IS NOT NULL AND object_version IS NOT NULL)
            AND (SELECT sum(frame_count) FROM video_visual_chunks WHERE run_id=?)>0 RETURNING run_id`)
          .bind(objectVersion,videoId,runId,objectVersion,runId,runId),
        database.prepare(`UPDATE visual_object_attempts SET status='published' WHERE id='m:'||? AND status='pending'
          AND EXISTS(SELECT 1 FROM video_visual_runs r JOIN videos v ON v.id=r.video_id WHERE r.run_id=? AND r.status='ready' AND r.publication_version=? AND r.file_key=v.file)`)
          .bind(objectVersion,runId,objectVersion),
      ]);
      return result[0].results.length>0;
    },
    async failure(videoId,runId,index) {
      await database.batch([
        database.prepare(`UPDATE video_visual_chunks SET failures=failures+1,last_error='VISUAL_CHUNK_FAILED',updated_at=${NOW}
          WHERE run_id=? AND chunk_index=? AND frame_count IS NULL AND EXISTS(SELECT 1 FROM ${JOINS} WHERE v.id=? AND r.run_id=? AND ${CURRENT} AND r.status<>'ready')`)
          .bind(runId,index ?? null,videoId,runId),
        database.prepare(`UPDATE video_visual_runs SET status='error',last_error='VISUAL_PROCESSING_FAILED'
          WHERE video_id=? AND run_id=? AND status<>'ready' AND EXISTS(SELECT 1 FROM videos v WHERE v.id=video_visual_runs.video_id AND v.file=video_visual_runs.file_key AND v.source_type='uploaded')
          AND (? IS NULL OR EXISTS(SELECT 1 FROM video_visual_chunks WHERE run_id=? AND chunk_index=? AND frame_count IS NULL))`)
          .bind(videoId,runId,index ?? null,runId,index ?? null),
      ]);
    },
  };
}
