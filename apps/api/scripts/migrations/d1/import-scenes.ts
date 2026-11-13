import type {D1Database} from '@cloudflare/workers-types';
import {createHash} from 'node:crypto';
import type {SceneEmbedding} from '../../../src/persistence/contracts/scene-index';
import {readArchiveLines} from './verify-archive';
export class SceneImportError extends Error {readonly name='SceneImportError';}
type PreparedScenes={path:string;rows:string};
type Row={scene:SceneEmbedding;videoId:number;userId:string;dimensions:768|1536;revision:string;vectorId:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Offline only: the index scheduler must remain stopped until this phase has
 * reconciled the durable source and outbox. Delivery is a separate operation. */
export async function importSceneTables(database:D1Database,prepared:PreparedScenes,archive:string,mapping:string){
 try{
  const parent="EXISTS(SELECT 1 FROM migration_imports WHERE id='common' AND archive_sha256=? AND status='common_imported')";
  const plan=digest({mapping,scene_import_version:1});
  const existing=await database.prepare("SELECT archive_sha256,mapping_sha256,status,row_index,table_index FROM migration_imports WHERE id='scenes'").first<{archive_sha256:string;mapping_sha256:string;status:string;row_index:number;table_index:number}>();
  if(existing&&(existing.archive_sha256!==archive||existing.mapping_sha256!==plan))throw new SceneImportError('Scene target belongs to another input or plan.');
  if(!existing)await database.batch([
   database.prepare(`SELECT CASE WHEN ${parent} AND NOT EXISTS(SELECT 1 FROM migration_imports WHERE id='scenes') AND NOT EXISTS(SELECT 1 FROM scenes) AND NOT EXISTS(SELECT 1 FROM scene_index_tasks) AND NOT EXISTS(SELECT 1 FROM scene_index_runs) AND NOT EXISTS(SELECT 1 FROM video_index_versions) AND NOT EXISTS(SELECT 1 FROM video_index_heads) AND NOT EXISTS(SELECT 1 FROM scene_staging) THEN 1 ELSE json('IMPORT_SCENE_TARGET_NOT_EMPTY') END`).bind(archive),
   database.prepare("INSERT INTO migration_imports(id,archive_sha256,mapping_sha256,status) VALUES('scenes',?,?,'importing_scenes')").bind(archive,plan),
  ]);
  const progress=existing??{status:'importing_scenes',row_index:0,table_index:0};
  if(!['importing_scenes','scenes_imported'].includes(progress.status)||progress.table_index!==0||!Number.isSafeInteger(progress.row_index)||progress.row_index<0||BigInt(progress.row_index)>BigInt(prepared.rows))throw new SceneImportError('Invalid scene import progress.');
  if(progress.status==='scenes_imported')await database.prepare("UPDATE migration_imports SET status='importing_scenes' WHERE id='scenes' AND archive_sha256=?").bind(archive).run();
  const statements=(row:Row)=>{
   const {scene,videoId,userId,dimensions,revision,vectorId}=row,source=digest(['offline-scene-source-v1',archive,videoId]);
   const values=[scene.id,videoId,scene.content,scene.startTime,scene.endTime,scene.evidenceType??'transcript',dimensions,revision,vectorId];
   const sceneCheck=database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM scenes WHERE id IS ? AND video_id IS ? AND content IS ? COLLATE BINARY AND start_time IS ? AND end_time IS ? AND evidence_type IS ? AND dimensions IS ? AND revision IS ? AND vector_id IS ?) THEN 1 ELSE json('IMPORT_SCENE_VALUE_MISMATCH') END`).bind(...values);
   const taskValues=[`u:${dimensions}:${vectorId}`,vectorId,scene.id,revision,videoId,userId,dimensions,JSON.stringify(scene.embedding)];
   const taskCheck=database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM scene_index_tasks WHERE id IS ? AND operation='upsert' AND vector_id IS ? AND scene_id IS ? AND revision IS ? AND video_id IS ? AND user_id IS ? AND dimensions IS ? AND embedding IS ? AND completed_at IS NULL AND lease_token IS NULL AND attempts=0) THEN 1 ELSE json('IMPORT_SCENE_OUTBOX_MISMATCH') END`).bind(...taskValues);
   const publicationCheck=database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM video_index_versions v JOIN video_index_heads h ON h.video_id=v.video_id JOIN scene_index_runs r ON r.id=h.run_id JOIN videos video ON video.id=v.video_id WHERE v.video_id=? AND v.revision=? AND h.dimensions=? AND h.run_id=? AND r.video_id=v.video_id AND r.dimensions=h.dimensions AND r.source_revision=v.revision AND r.user_id=? AND video.user_id=r.user_id AND r.status='published') THEN 1 ELSE json('IMPORT_SCENE_PUBLICATION_MISMATCH') END`).bind(videoId,source,dimensions,revision,userId);
   return {values,taskValues,source,checks:[sceneCheck,taskCheck,publicationCheck]};
  };
  let offset=0;
  for await(const line of readArchiveLines(prepared.path)){
   const row=JSON.parse(line.toString()) as Row;if(offset++<progress.row_index)continue;
   const {values,taskValues,source,checks}=statements(row);
   await database.batch([
    database.prepare(`SELECT CASE WHEN ${parent} AND EXISTS(SELECT 1 FROM migration_imports WHERE id='scenes' AND archive_sha256=? AND status='importing_scenes' AND row_index=?) THEN 1 ELSE json('IMPORT_SCENE_PROGRESS_CHANGED') END`).bind(archive,archive,offset-1),
    database.prepare('INSERT INTO video_index_versions(video_id,revision) VALUES(?,?) ON CONFLICT DO NOTHING').bind(row.videoId,source),
    database.prepare("INSERT INTO scene_index_runs(id,video_id,user_id,source_revision,dimensions,expected_scenes,status) VALUES(?,?,?,?,?,0,'published') ON CONFLICT DO NOTHING").bind(row.revision,row.videoId,row.userId,source,row.dimensions),
    database.prepare('INSERT INTO video_index_heads(video_id,dimensions,run_id) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(row.videoId,row.dimensions,row.revision),
    database.prepare('INSERT INTO scenes(id,video_id,content,start_time,end_time,evidence_type,dimensions,revision,vector_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(...values),
    database.prepare("INSERT INTO scene_index_tasks(id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions,embedding) VALUES(?,'upsert',?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(...taskValues),
    ...checks,
    database.prepare("UPDATE migration_imports SET row_index=?,imported_rows=imported_rows+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scenes'").bind(offset),
   ]);
  }
  // Re-read every prepared value even on completed retries; never trust only a marker.
  for await(const line of readArchiveLines(prepared.path)){const row=JSON.parse(line.toString()) as Row;await database.batch(statements(row).checks);}
  if((await database.prepare('PRAGMA foreign_key_check').all()).results.length)throw new SceneImportError('Scene foreign-key reconciliation failed.');
  const result=await database.batch([
   database.prepare(`SELECT CASE WHEN (SELECT count(*) FROM scenes)=? AND (SELECT count(*) FROM scene_index_tasks)=? AND NOT EXISTS(SELECT 1 FROM scene_staging) AND (SELECT count(*) FROM scene_index_runs)=(SELECT count(*) FROM (SELECT DISTINCT video_id,dimensions FROM scenes)) AND (SELECT count(*) FROM video_index_heads)=(SELECT count(*) FROM scene_index_runs) AND (SELECT count(*) FROM video_index_versions)=(SELECT count(DISTINCT video_id) FROM scenes) THEN 1 ELSE json('IMPORT_SCENE_COUNT_MISMATCH') END`).bind(Number(prepared.rows),Number(prepared.rows)),
   database.prepare('UPDATE scene_index_runs SET expected_scenes=(SELECT count(*) FROM scenes s WHERE s.revision=scene_index_runs.id AND s.video_id=scene_index_runs.video_id AND s.dimensions=scene_index_runs.dimensions)'),
   database.prepare(`SELECT CASE WHEN ${parent} AND EXISTS(SELECT 1 FROM migration_imports WHERE id='scenes' AND archive_sha256=? AND status='importing_scenes' AND row_index=?) THEN 1 ELSE json('IMPORT_SCENE_COMPLETION_CHANGED') END`).bind(archive,archive,Number(prepared.rows)),
   database.prepare("UPDATE migration_imports SET status='scenes_imported',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scenes' RETURNING id"),
  ]);
  if(!result[3].results.length)throw new SceneImportError('Scene completion checkpoint changed.');
  return {scene_import_complete:true,scenes_imported:prepared.rows,vectorize_delivery_complete:false,pending_vectorize_rows:prepared.rows};
 }catch(error){if(error instanceof SceneImportError)throw error;throw new SceneImportError('Scene import failed; keep the target offline for inspection or retry.');}
}
