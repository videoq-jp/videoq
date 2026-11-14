import type {D1Database} from '@cloudflare/workers-types';
import {createHash} from 'node:crypto';
import {copyVisualArtifacts,type VisualMigrationDestination} from './copy-visual-artifacts';
import {prepareVisualArtifacts,type VisualMigrationSource,type VisualArtifact} from './visual-artifacts';
import {readArchiveLines} from './verify-archive';
import type {prepareVisualImport} from './prepare-visuals';
export class VisualImportError extends Error {readonly name='VisualImportError';}
/** Must stay offline through copy, reference publication and reconciliation. */
export async function importVisualObjects(database:D1Database,plans:Awaited<ReturnType<typeof prepareVisualImport>>,archive:string,directory:string,storage:{source:VisualMigrationSource;destination:VisualMigrationDestination;offlineStaging:true}){
 if(storage.offlineStaging!==true)throw new VisualImportError('Visual migration requires offline staging.');
 try{
  const prepared=await prepareVisualArtifacts(plans,archive,directory,storage.source);
  const mapping=createHash('sha256').update(JSON.stringify({version:1,artifacts:prepared.sha256,runs:plans.runs})).digest('hex');
  const parent="EXISTS(SELECT 1 FROM migration_imports WHERE id='common' AND archive_sha256=? AND status='common_imported')";
  const existing=await database.prepare("SELECT archive_sha256,mapping_sha256,status FROM migration_imports WHERE id='visuals'").first<{archive_sha256:string;mapping_sha256:string;status:string}>();
  if(existing&&(existing.archive_sha256!==archive||existing.mapping_sha256!==mapping||!['importing_visuals','visuals_imported'].includes(existing.status)))throw new VisualImportError('Visual target belongs to another input or plan.');
  if(!existing)await database.batch([
   database.prepare(`SELECT CASE WHEN ${parent} AND NOT EXISTS(SELECT 1 FROM migration_imports WHERE id='visuals') AND NOT EXISTS(SELECT 1 FROM visual_object_attempts) AND NOT EXISTS(SELECT 1 FROM video_visual_runs WHERE publication_version IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM video_visual_chunks WHERE object_version IS NOT NULL) THEN 1 ELSE json('IMPORT_VISUAL_TARGET_NOT_EMPTY') END`).bind(archive),
   database.prepare("INSERT INTO migration_imports(id,archive_sha256,mapping_sha256,status) VALUES('visuals',?,?,'importing_visuals')").bind(archive,mapping),
  ]);
  // Record cleanup ownership before external writes, including a failed PUT.
  let groups=0;
  for await(const line of readArchiveLines(prepared.path)){
   const artifact=JSON.parse(line.toString()) as VisualArtifact;if(artifact.kind==='overview'||artifact.kind==='chunk'&&!artifact.key.endsWith('.bin'))continue;
   const chunk=artifact.kind==='chunk',id=(chunk?'c:':'m:')+artifact.version;
   const desired=chunk?"EXISTS(SELECT 1 FROM video_visual_chunks c WHERE c.run_id=r.run_id AND c.chunk_index=? AND c.frame_count IS NOT NULL AND (c.object_version IS NULL OR c.object_version=?))":"r.status='ready' AND (r.publication_version IS NULL OR r.publication_version=?)";
   const args=chunk?[artifact.index,artifact.version]:[artifact.version];
   const prefix=artifact.fileKey;
   await database.batch([
    database.prepare(`SELECT CASE WHEN ${parent} AND EXISTS(SELECT 1 FROM migration_imports WHERE id='visuals' AND archive_sha256=? AND mapping_sha256=?) AND EXISTS(SELECT 1 FROM video_visual_runs r JOIN videos v ON v.id=r.video_id WHERE r.run_id=? AND r.video_id=? AND r.file_key=? AND v.file=r.file_key AND v.source_type='uploaded' AND ${desired}) THEN 1 ELSE json('IMPORT_VISUAL_SOURCE_CHANGED') END`).bind(archive,archive,mapping,artifact.runId,artifact.videoId,prefix,...args),
    database.prepare(`INSERT INTO visual_object_attempts(id,kind,video_id,run_id,file_key,chunk_index,object_version,expires_at,available_at) VALUES(?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')) ON CONFLICT DO NOTHING`).bind(id,chunk?'chunk':'manifest',artifact.videoId,artifact.runId,prefix,artifact.index,artifact.version),
    database.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM visual_object_attempts WHERE id=? AND kind=? AND video_id=? AND run_id=? AND file_key=? AND chunk_index IS ? AND object_version=? AND status IN ('pending','published') AND lease_token IS NULL) THEN 1 ELSE json('IMPORT_VISUAL_LEDGER_CONFLICT') END").bind(id,chunk?'chunk':'manifest',artifact.videoId,artifact.runId,prefix,artifact.index,artifact.version),
   ]);groups++;
  }
  const copied=await copyVisualArtifacts(prepared,storage.destination,{offlineStaging:true});
  for await(const line of readArchiveLines(prepared.path)){
   const artifact=JSON.parse(line.toString()) as VisualArtifact;if(artifact.kind==='overview'||artifact.kind==='chunk'&&!artifact.key.endsWith('.bin'))continue;
   const chunk=artifact.kind==='chunk',id=(chunk?'c:':'m:')+artifact.version;
   const update=chunk?database.prepare('UPDATE video_visual_chunks SET object_version=? WHERE run_id=? AND chunk_index=? AND frame_count IS NOT NULL AND (object_version IS NULL OR object_version=?)').bind(artifact.version,artifact.runId,artifact.index,artifact.version):database.prepare("UPDATE video_visual_runs SET publication_version=? WHERE run_id=? AND video_id=? AND status='ready' AND (publication_version IS NULL OR publication_version=?) AND chunk_count=(SELECT count(*) FROM video_visual_chunks c WHERE c.run_id=video_visual_runs.run_id AND c.frame_count IS NOT NULL AND c.object_version IS NOT NULL)").bind(artifact.version,artifact.runId,artifact.videoId,artifact.version);
   const check=chunk?database.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM video_visual_chunks WHERE run_id=? AND chunk_index=? AND object_version=?) THEN 1 ELSE json('IMPORT_VISUAL_CHUNK_CONFLICT') END").bind(artifact.runId,artifact.index,artifact.version):database.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM video_visual_runs WHERE run_id=? AND publication_version=?) THEN 1 ELSE json('IMPORT_VISUAL_PUBLICATION_CONFLICT') END").bind(artifact.runId,artifact.version);
   await database.batch([database.prepare(`SELECT CASE WHEN ${parent} AND EXISTS(SELECT 1 FROM visual_object_attempts WHERE id=? AND status IN ('pending','published') AND lease_token IS NULL) AND EXISTS(SELECT 1 FROM video_visual_runs r JOIN videos v ON v.id=r.video_id WHERE r.run_id=? AND r.video_id=? AND r.file_key=? AND v.file=r.file_key AND v.source_type='uploaded') THEN 1 ELSE json('IMPORT_VISUAL_LEDGER_CHANGED') END`).bind(archive,id,artifact.runId,artifact.videoId,artifact.fileKey),update,check,database.prepare("UPDATE visual_object_attempts SET status='published' WHERE id=?").bind(id)]);
  }
  await database.prepare(`SELECT CASE WHEN (SELECT count(*) FROM visual_object_attempts)=? AND NOT EXISTS(SELECT 1 FROM visual_object_attempts WHERE status<>'published') AND NOT EXISTS(SELECT 1 FROM video_visual_chunks WHERE (frame_count IS NOT NULL AND object_version IS NULL) OR (frame_count IS NULL AND object_version IS NOT NULL)) AND NOT EXISTS(SELECT 1 FROM video_visual_runs WHERE (status='ready' AND publication_version IS NULL) OR (status<>'ready' AND publication_version IS NOT NULL)) AND (SELECT count(*) FROM video_visual_runs)=? THEN 1 ELSE json('IMPORT_VISUAL_RECONCILIATION_FAILED') END`).bind(groups,Number(plans.runs)).all();
  const result=await database.prepare(`UPDATE migration_imports SET status='visuals_imported',imported_rows=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='visuals' AND archive_sha256=? AND mapping_sha256=? AND ${parent} RETURNING id`).bind(groups,archive,mapping,archive).all();
  if(!result.results.length)throw new VisualImportError('Visual migration completion changed.');
  return {...copied,visual_objects_migrated:true,pending_visual_runs:'0',visual_runs_imported:plans.runs,execution_complete:false};
 }catch(error){if(error instanceof VisualImportError)throw error;throw new VisualImportError('Visual migration failed; keep the target offline for inspection or retry.');}
}
