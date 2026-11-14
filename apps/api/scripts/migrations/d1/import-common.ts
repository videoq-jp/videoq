import type {D1Database,D1PreparedStatement} from '@cloudflare/workers-types';
import {importVisualObjects} from './import-visuals';
import type {VisualMigrationSource} from './visual-artifacts';
import type {VisualMigrationDestination} from './copy-visual-artifacts';
import {importSceneTables} from './import-scenes';
import {importCheckpointTables} from './import-checkpoints';
import {migrationBatches} from './batches';
import {createHash} from 'node:crypto';
import {buildMigrationManifest,quoteMigrationIdentifier as quote} from './manifest';
import {validateSequenceTargets,restoreSequenceTargets} from './restore-sequences';
import {prepareCommonImport} from './prepare-import';
import {readArchiveLines} from './verify-archive';
type Manifest=ReturnType<typeof buildMigrationManifest>;
export class CommonImportError extends Error {readonly name='CommonImportError';}
/** Explicitly offline/staging only. Never returns cutover-ready. Progress and
 * row writes share a D1 batch, so an ambiguous response can safely be retried. */
export async function importCommonTables(database:D1Database,input:string,manifest:Manifest,options:{offlineStaging:true;batchRows?:number;visualStorage?:{source:VisualMigrationSource;destination:VisualMigrationDestination}}){
 if(options.offlineStaging!==true)throw new CommonImportError('Only an offline staging database may be imported.');
 const batchRows=options.batchRows??10;if(!Number.isSafeInteger(batchRows)||batchRows<1||batchRows>25)throw new CommonImportError('Invalid import batch size.');
 const prepared=await prepareCommonImport(input,manifest);
 try{
  const archive=prepared.verified.archive_sha256,mapping=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const all=manifest.target_insert_order;
  if(!all.includes('migration_imports'))throw new CommonImportError('Target schema requires the import progress migration.');
  const catalog=(await database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>()).results.map(row=>row.name);
  if(all.some(name=>!catalog.includes(name))||catalog.some(name=>!name.startsWith('sqlite_')&&!name.startsWith('_cf_')&&name!=='d1_migrations'&&!all.includes(name)))throw new CommonImportError('Target schema inventory mismatch.');
  const commonTables=manifest.tables.filter(table=>table.policy==='convert_rows');
  const columnResults=await migrationBatches<{name:string;type:string;notnull:number}>(database,commonTables.map(table=>database.prepare(`PRAGMA table_info(${quote(table.target!)})`)));
  for(let index=0;index<commonTables.length;index++){
   const table=commonTables[index],columns=columnResults[index].results;
   if(columns.length!==table.columns.length+table.added_columns.length||columns.some(column=>!table.columns.some(mapped=>mapped.name===column.name)&&!table.added_columns.some(added=>added.name===column.name))||table.columns.some(mapped=>!columns.some(column=>column.name===mapped.name&&column.type.toLowerCase()===mapped.target_type&&Boolean(column.notnull)===!mapped.nullable)))throw new CommonImportError('Target column schema mismatch.');
  }
  await validateSequenceTargets(database,prepared.sequences);
  const state=await database.prepare("SELECT archive_sha256,mapping_sha256,status,table_index,row_index FROM migration_imports WHERE id='common'").first<{archive_sha256:string;mapping_sha256:string;status:string;table_index:number;row_index:number}>();
  if(state&&(state.archive_sha256!==archive||state.mapping_sha256!==mapping))throw new CommonImportError('Target belongs to a different archive.');
  if(!state){
   const empty=all.filter(name=>name!=='migration_imports').map(name=>`NOT EXISTS(SELECT 1 FROM ${quote(name)} LIMIT 1)`).join(' AND ');
   await database.batch([
    database.prepare(`SELECT CASE WHEN ${empty} AND NOT EXISTS(SELECT 1 FROM migration_imports) THEN 1 ELSE json('IMPORT_TARGET_NOT_EMPTY') END`),
    database.prepare("INSERT INTO migration_imports(id,archive_sha256,mapping_sha256,status) VALUES('common',?,?,'importing_common')").bind(archive,mapping),
   ]);
  }
  let progress=state??{table_index:0,row_index:0,status:'importing_common'};
  const ordered=all.map(name=>prepared.tables.find(table=>table.name===name)).filter(table=>table!==undefined);
  if(ordered.length!==prepared.tables.length)throw new CommonImportError('Target import order is incomplete.');
  if(!['importing_common','common_imported'].includes(progress.status)||!Number.isSafeInteger(progress.table_index)||progress.table_index<0||progress.table_index>ordered.length||!Number.isSafeInteger(progress.row_index)||progress.row_index<0)throw new CommonImportError('Invalid import progress.');
  if(progress.status==='common_imported')await database.prepare("UPDATE migration_imports SET status='importing_common' WHERE id='common' AND archive_sha256=?").bind(archive).run();
  for(let index=progress.table_index;index<ordered.length;index++){
   const table=ordered[index];if(table.columns.length>98)throw new CommonImportError('Import statement exceeds supported column count.');
   if(table.rows==='0'){
    let next=index+1;while(next<ordered.length&&ordered[next].rows==='0')next++;
    const empty=ordered.slice(index,next).map(table=>`NOT EXISTS(SELECT 1 FROM ${quote(table.name)} LIMIT 1)`).join(' AND ');
    await database.batch([
     database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_imports WHERE id='common' AND archive_sha256=? AND status='importing_common' AND table_index=? AND row_index=0) AND ${empty} THEN 1 ELSE json('IMPORT_EMPTY_TABLE_PROGRESS') END`).bind(archive,index),
     database.prepare("UPDATE migration_imports SET table_index=?,row_index=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='common'").bind(next),
    ]);
    progress={table_index:next,row_index:0,status:'importing_common'};index=next-1;continue;
   }

   let offset=0,rows:(string|number|null)[][]=[];
   const apply=async()=>{
    if(!rows.length)return;const expected=offset-rows.length;
    const statements=[database.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_imports WHERE id='common' AND archive_sha256=? AND status='importing_common' AND table_index=? AND row_index=?) THEN 1 ELSE json('IMPORT_PROGRESS_CHANGED') END").bind(archive,index,expected)];
    for(const values of rows){
     statements.push(database.prepare(`INSERT INTO ${quote(table.name)}(${table.columns.map(quote).join(',')}) VALUES(${values.map(()=>'?').join(',')}) ON CONFLICT DO NOTHING`).bind(...values));
     statements.push(database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${quote(table.name)} WHERE ${table.columns.map(column=>quote(column)+' IS ? COLLATE BINARY').join(' AND ')}) THEN 1 ELSE json('IMPORT_ROW_CONFLICT') END`).bind(...values));
    }
    statements.push(database.prepare("UPDATE migration_imports SET row_index=?,imported_rows=imported_rows+?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='common'").bind(offset,rows.length));
    await database.batch(statements);rows=[];
   };
   for await(const line of readArchiveLines(table.path)){
    const row=JSON.parse(line.toString('utf8')) as {values:(string|number|null)[]};
    if(offset++<(index===progress.table_index?progress.row_index:0))continue;
    rows.push(row.values);if(rows.length===batchRows)await apply();
   }
   await apply();
   await database.batch([
    database.prepare(`SELECT CASE WHEN (SELECT count(*) FROM ${quote(table.name)})=? THEN 1 ELSE json('IMPORT_COUNT_MISMATCH') END`).bind(Number(table.rows)),
    database.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_imports WHERE id='common' AND archive_sha256=? AND table_index=? AND row_index=?) THEN 1 ELSE json('IMPORT_PROGRESS_CHANGED') END").bind(archive,index,offset),
    database.prepare("UPDATE migration_imports SET table_index=?,row_index=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='common'").bind(index+1),
   ]);
   progress={table_index:index+1,row_index:0,status:'importing_common'};
  }
  // Reconcile even previously committed batches, including a completed retry.
  // Offline ownership is required throughout; this does not authorize cutover.
  let checks:D1PreparedStatement[]=[];
  const flush=async()=>{if(checks.length){await database.batch(checks);checks=[];}};
  for(const table of ordered){
   for await(const line of readArchiveLines(table.path)){
    const row=JSON.parse(line.toString('utf8')) as {values:(string|number|null)[]};
    checks.push(database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${quote(table.name)} WHERE ${table.columns.map(column=>quote(column)+' IS ? COLLATE BINARY').join(' AND ')}) THEN 1 ELSE json('IMPORT_VALUE_MISMATCH') END`).bind(...row.values));
    if(checks.length>=25)await flush();
   }
  }
  await flush();
  await migrationBatches(database,ordered.map(table=>database.prepare(`SELECT CASE WHEN (SELECT count(*) FROM ${quote(table.name)})=? THEN 1 ELSE json('IMPORT_COUNT_MISMATCH') END`).bind(Number(table.rows))));
  if((await database.prepare('PRAGMA foreign_key_check').all()).results.length)throw new CommonImportError('Foreign key reconciliation failed.');
  await restoreSequenceTargets(database,prepared.sequences,archive);
  const completed=await database.prepare("UPDATE migration_imports SET status='common_imported',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='common' AND archive_sha256=? AND status='importing_common' AND table_index=? AND row_index=0 RETURNING id").bind(archive,ordered.length).all();
  if(!completed.results.length)throw new CommonImportError('Import completion checkpoint changed.');
  const checkpointResult=await importCheckpointTables(database,prepared.checkpoints.tables,archive,mapping);
  const sceneResult=await importSceneTables(database,prepared.scenes,archive,mapping);
  const visualResult=options.visualStorage?await importVisualObjects(database,prepared.visuals,archive,prepared.directory,{...options.visualStorage,offlineStaging:true}):{pending_visual_runs:prepared.visuals.runs,visual_objects_migrated:false};
  return {...visualResult,...sceneResult,checkpoint_migration:prepared.checkpoints.summary,...checkpointResult,common_import_complete:true,execution_complete:false,pending_special_rows:(BigInt(prepared.pending_special_rows)-BigInt(prepared.scenes.rows)).toString(),pending_sequence_restore:false,sequences_restored:prepared.sequences.length,tables:ordered.length};
 }catch(error){if(error instanceof CommonImportError)throw error;throw new CommonImportError('D1 common import failed; the target must remain offline for inspection or retry.');}finally{await prepared.dispose();}
}
