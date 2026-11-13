export const VISUAL_OBJECT_DESIRED = `(EXISTS(SELECT 1 FROM video_visual_runs r JOIN videos v ON v.id=r.video_id
  WHERE r.run_id=visual_object_attempts.run_id AND v.id=visual_object_attempts.video_id AND v.file=visual_object_attempts.file_key
    AND r.file_key=v.file AND v.source_type='uploaded' AND ((visual_object_attempts.kind='manifest' AND r.status='ready' AND r.publication_version=visual_object_attempts.object_version) OR
      (visual_object_attempts.kind='chunk' AND EXISTS(SELECT 1 FROM video_visual_chunks c WHERE c.run_id=r.run_id
        AND c.chunk_index=visual_object_attempts.chunk_index AND c.object_version=visual_object_attempts.object_version)))))`;
export async function beginVisualObject(database:D1Database,videoId:number,runId:string,version:string,index?:number) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(version) ||
    (index!==undefined && (!Number.isSafeInteger(index) || index<0 || index>599))) throw new Error("Invalid visual object attempt");
  const id=`${index===undefined?'m':'c'}:${version}`;
  const result=await database.batch([
    database.prepare(`INSERT INTO visual_object_attempts(id,kind,video_id,run_id,file_key,chunk_index,object_version,expires_at,available_at)
      SELECT ?,?,v.id,r.run_id,r.file_key,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')
      FROM video_visual_runs r JOIN videos v ON v.id=r.video_id WHERE v.id=? AND r.run_id=? AND r.file_key=v.file AND v.source_type='uploaded' AND r.status<>'ready'
        AND (? IS NULL OR EXISTS(SELECT 1 FROM video_visual_chunks c WHERE c.run_id=r.run_id AND c.chunk_index=? AND c.frame_count IS NULL))
      ON CONFLICT(id) DO NOTHING`)
      .bind(id,index===undefined?'manifest':'chunk',index??null,version,videoId,runId,index??null,index??null),
    database.prepare(`SELECT a.id FROM visual_object_attempts a JOIN video_visual_runs r ON r.run_id=a.run_id JOIN videos v ON v.id=r.video_id
      WHERE a.id=? AND a.video_id=? AND a.run_id=? AND a.status='pending' AND julianday(a.expires_at)>julianday('now')
        AND v.file=a.file_key AND r.file_key=v.file AND v.source_type='uploaded' AND r.status<>'ready'`).bind(id,videoId,runId),
  ]);
  return result[1].results.length>0;
}
export type VisualCleanup={id:string;kind:'chunk'|'manifest';file_key:string;run_id:string;chunk_index:number|null;object_version:string;lease_token:string};
export function createVisualObjectCleanup(database:D1Database) {
  return {
    async claim():Promise<VisualCleanup|null> {
      return database.prepare(`UPDATE visual_object_attempts SET status='deleting',lease_token=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),attempts=attempts+1
        WHERE id=(SELECT id FROM visual_object_attempts WHERE status<>'cleaned' AND julianday(available_at)<=julianday('now')
          AND (lease_token IS NULL OR julianday(lease_until)<=julianday('now'))
          AND NOT ${VISUAL_OBJECT_DESIRED}
          ORDER BY available_at,id LIMIT 1) RETURNING id,kind,file_key,run_id,chunk_index,object_version,lease_token`)
        .bind(crypto.randomUUID()).first<VisualCleanup>();
    },
    async complete(task:VisualCleanup) {
      const result=await database.prepare(`UPDATE visual_object_attempts SET status='cleaned',lease_token=NULL,lease_until=NULL,last_error_code=''
        WHERE id=? AND status='deleting' AND lease_token=? AND julianday(lease_until)>julianday('now') RETURNING id`).bind(task.id,task.lease_token).all();
      return result.results.length>0;
    },
    async retry(task:VisualCleanup) {
      await database.prepare(`UPDATE visual_object_attempts SET lease_token=NULL,lease_until=NULL,last_error_code='VISUAL_OBJECT_DELETE_FAILED',
        available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id=? AND status='deleting' AND lease_token=?`).bind(task.id,task.lease_token).run();
    },
  };
}
