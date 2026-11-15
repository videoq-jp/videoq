import type {D1Database,D1PreparedStatement} from '@cloudflare/workers-types';
import {createHash} from 'node:crypto';
import {D1_CHECKPOINT_MAX_BYTES} from '../../../src/persistence/d1/checkpoint-limits';
import type {PreparedCheckpointTable} from './prepare-checkpoints';
import {readArchiveLines} from './verify-archive';
import {quoteMigrationIdentifier as quote} from './manifest';
import {migrationBatches} from './batches';
export class CheckpointImportError extends Error {readonly name='CheckpointImportError';}
const rowsKey="id='checkpoints' AND archive_sha256=? AND status='importing_checkpoints' AND table_index=? AND row_index=?";
const blob=(value:string|number|null)=>{if(typeof value!=='string'||!/^(?:[0-9a-f]{2})*$/.test(value))throw new CheckpointImportError('Invalid prepared checkpoint blob.');return Uint8Array.from(Buffer.from(value,'hex')).buffer;};
export async function importCheckpointTables(database:D1Database,tables:PreparedCheckpointTable[],archive:string,mapping:string){
 try{
  const parent="EXISTS(SELECT 1 FROM migration_imports WHERE id='common' AND archive_sha256=? AND status='common_imported')";
  const noMissingCommit="NOT EXISTS(SELECT 1 FROM chat_conversations c WHERE c.committed_checkpoint_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversation_checkpoints p WHERE p.thread_id=c.thread_id AND p.namespace='' AND p.checkpoint_id=c.committed_checkpoint_id))";
  if(!tables.length){
   await database.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM conversation_checkpoints) AND NOT EXISTS(SELECT 1 FROM conversation_checkpoint_writes) AND ${noMissingCommit} THEN 1 ELSE json('IMPORT_UNEXPECTED_CHECKPOINTS') END`).all();
   return {checkpoint_import_complete:true,checkpoints:'0',writes:'0'};
  }
  if(tables.length!==2||tables[0].name!=='conversation_checkpoints'||tables[1].name!=='conversation_checkpoint_writes')throw new CheckpointImportError('Invalid prepared checkpoint table plan.');
  const plan=createHash('sha256').update(JSON.stringify({mapping,checkpoint_import_version:1,tables:tables.map(({name,columns,binary_columns})=>({name,columns,binary_columns}))})).digest('hex');
  const existing=await database.prepare("SELECT archive_sha256,mapping_sha256,status,table_index,row_index FROM migration_imports WHERE id='checkpoints'").first<{archive_sha256:string;mapping_sha256:string;status:string;table_index:number;row_index:number}>();
  if(existing&&(existing.archive_sha256!==archive||existing.mapping_sha256!==plan))throw new CheckpointImportError('Checkpoint target belongs to another input or plan.');
  if(!existing)await database.batch([
   database.prepare(`SELECT CASE WHEN ${parent} AND NOT EXISTS(SELECT 1 FROM migration_imports WHERE id='checkpoints') AND NOT EXISTS(SELECT 1 FROM conversation_checkpoints) AND NOT EXISTS(SELECT 1 FROM conversation_checkpoint_writes) THEN 1 ELSE json('IMPORT_CHECKPOINT_TARGET_NOT_EMPTY') END`).bind(archive),
   database.prepare("INSERT INTO migration_imports(id,archive_sha256,mapping_sha256,status) VALUES('checkpoints',?,?,'importing_checkpoints')").bind(archive,plan),
  ]);
  const progress=existing??{table_index:0,row_index:0,status:'importing_checkpoints'};
  if(!['importing_checkpoints','checkpoints_imported'].includes(progress.status)||!Number.isSafeInteger(progress.table_index)||progress.table_index<0||progress.table_index>tables.length||!Number.isSafeInteger(progress.row_index)||progress.row_index<0)throw new CheckpointImportError('Invalid checkpoint import progress.');
  if(progress.status==='checkpoints_imported')await database.prepare("UPDATE migration_imports SET status='importing_checkpoints' WHERE id='checkpoints' AND archive_sha256=?").bind(archive).run();
  const values=(table:PreparedCheckpointTable,line:Buffer)=>{const row=JSON.parse(line.toString()) as {values:(string|number|null)[]};return row.values.map((value,index)=>table.binary_columns.includes(index)?blob(value):value);};
  for(let index=progress.table_index;index<tables.length;index++){
   const table=tables[index];let offset=0,budget=0,batch:ReturnType<typeof values>[]=[];
   const apply=async()=>{
    if(!batch.length)return;const statements=[database.prepare(`SELECT CASE WHEN ${parent} AND EXISTS(SELECT 1 FROM migration_imports WHERE ${rowsKey}) THEN 1 ELSE json('IMPORT_CHECKPOINT_PROGRESS_CHANGED') END`).bind(archive,archive,index,offset-batch.length)];
    for(const row of batch){statements.push(database.prepare(`INSERT INTO ${quote(table.name)}(${table.columns.map(quote).join(',')}) VALUES(${row.map(()=>'?').join(',')}) ON CONFLICT DO NOTHING`).bind(...row),database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${quote(table.name)} WHERE ${table.columns.map(column=>quote(column)+' IS ? COLLATE BINARY').join(' AND ')}) THEN 1 ELSE json('IMPORT_CHECKPOINT_CONFLICT') END`).bind(...row));}
    statements.push(database.prepare("UPDATE migration_imports SET row_index=?,imported_rows=imported_rows+?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='checkpoints'").bind(offset,batch.length));
    await database.batch(statements);batch=[];budget=0;
   };
   for await(const line of readArchiveLines(table.path)){
    if(offset<(index===progress.table_index?progress.row_index:0)){offset++;continue;}
    const row=values(table,line),size=row.reduce<number>((sum,value)=>sum+(value instanceof ArrayBuffer?value.byteLength:typeof value==='string'?Buffer.byteLength(value):8),0);
    if(batch.length&&(batch.length>=10||budget+size>D1_CHECKPOINT_MAX_BYTES))await apply();
    batch.push(row);budget+=size;offset++;
   }
   await apply();await database.batch([
    database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_imports WHERE ${rowsKey}) AND (SELECT count(*) FROM ${quote(table.name)})=? THEN 1 ELSE json('IMPORT_CHECKPOINT_COUNT_MISMATCH') END`).bind(archive,index,offset,Number(table.rows)),
    database.prepare("UPDATE migration_imports SET table_index=?,row_index=0 WHERE id='checkpoints'").bind(index+1),
   ]);
  }
  for(const table of tables){let checks:D1PreparedStatement[]=[],budget=0;
   const flush=async()=>{if(checks.length){await database.batch(checks);checks=[];budget=0;}};
   for await(const line of readArchiveLines(table.path)){const row=values(table,line),size=line.byteLength;if(checks.length&&(checks.length>=10||budget+size>D1_CHECKPOINT_MAX_BYTES))await flush();checks.push(database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${quote(table.name)} WHERE ${table.columns.map(column=>quote(column)+' IS ? COLLATE BINARY').join(' AND ')}) THEN 1 ELSE json('IMPORT_CHECKPOINT_VALUE_MISMATCH') END`).bind(...row));budget+=size;}
   await flush();
  }
  await migrationBatches(database,tables.map(table=>database.prepare(`SELECT CASE WHEN (SELECT count(*) FROM ${quote(table.name)})=? THEN 1 ELSE json('IMPORT_CHECKPOINT_COUNT_MISMATCH') END`).bind(Number(table.rows))));
  await database.prepare(`SELECT CASE WHEN ${noMissingCommit} THEN 1 ELSE json('IMPORT_COMMITTED_CHECKPOINT_MISSING') END`).all();
  if((await database.prepare('PRAGMA foreign_key_check').all()).results.length)throw new CheckpointImportError('Checkpoint foreign-key reconciliation failed.');
  const result=await database.prepare(`UPDATE migration_imports SET status='checkpoints_imported',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='checkpoints' AND archive_sha256=? AND status='importing_checkpoints' AND table_index=2 AND row_index=0 AND ${parent} RETURNING id`).bind(archive,archive).all();
  if(!result.results.length)throw new CheckpointImportError('Checkpoint completion checkpoint changed.');
  return {checkpoint_import_complete:true,checkpoints:tables[0].rows,writes:tables[1].rows};
 }catch(error){if(error instanceof CheckpointImportError)throw error;throw new CheckpointImportError('Checkpoint import failed; keep the target offline for inspection or retry.');}
}
