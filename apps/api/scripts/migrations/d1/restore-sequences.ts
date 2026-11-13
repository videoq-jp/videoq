import {migrationBatches} from './batches';
import type {D1Database} from '@cloudflare/workers-types';
import type {SequenceState} from './sequence-format';
import type {buildMigrationManifest} from './manifest';
import {quoteMigrationIdentifier as quote} from './manifest';
export type SequenceRestore={table:string;column:string;floor:number};
/** This application's identity columns use standard non-cycling bigint
 * sequences. Other configurations require an explicit migration policy. */
export function planSequenceRestore(sequences:SequenceState[],manifest:ReturnType<typeof buildMigrationManifest>):SequenceRestore[]{
 const seen=new Set<string>();return sequences.map(sequence=>{
  if(sequence.increment_by!=='1'||sequence.min_value!=='1'||sequence.max_value!=='9223372036854775807'||sequence.cycle||BigInt(sequence.cache_size)<1n)throw new Error('Unsupported source sequence configuration.');
  if(!sequence.owner_table||!sequence.owner_column||sequence.owner_schema!==sequence.schema)throw new Error('Source sequence ownership is not mapped.');
  const table=manifest.tables.find(table=>table.source===sequence.owner_table&&table.policy==='convert_rows');
  if(!table?.target||!table.columns.some(column=>column.name===sequence.owner_column&&column.conversion==='safe_integer'))throw new Error('Source sequence column is not mapped.');
  const last=BigInt(sequence.last_value);if(last<1n||last>9223372036854775807n)throw new Error('Invalid source sequence state.');
  const floor=last-(sequence.is_called?0n:1n);
  if(floor>=BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Sequence leaves no safe next JavaScript integer.');
  if(seen.has(table.target))throw new Error('Ambiguous source sequence ownership.');seen.add(table.target);
  return {table:table.target,column:sequence.owner_column,floor:Number(floor)};
 });
}
export async function validateSequenceTargets(database:D1Database,plan:SequenceRestore[]){
 type Row={sql?:string;name?:string;type?:string;pk?:number;value?:string|null;storage_type?:string};
 const result=await migrationBatches<Row>(database,plan.flatMap(entry=>[
  database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(entry.table),
  database.prepare(`PRAGMA table_info(${quote(entry.table)})`),
  database.prepare('SELECT CAST(seq AS TEXT) AS value,typeof(seq) AS storage_type FROM sqlite_sequence WHERE name=?').bind(entry.table),
  database.prepare(`SELECT CAST(max(${quote(entry.column)}) AS TEXT) AS value FROM ${quote(entry.table)}`),
 ]));
 for(let index=0;index<plan.length;index++){
  const entry=plan[index],definition=result[index*4].results[0],columns=result[index*4+1].results,current=result[index*4+2].results,maximum=result[index*4+3].results[0]?.value;
  if(!definition?.sql||!/\bAUTOINCREMENT\b/i.test(definition.sql)||!columns.some(column=>column.name===entry.column&&column.type?.toLowerCase()==='integer'&&column.pk===1))throw new Error('Sequence target requires an integer AUTOINCREMENT key.');
  if(current.length>1||current.some(row=>row.storage_type!=='integer'||typeof row.value!=='string'||!/^-?\d+$/.test(row.value)||BigInt(row.value)>=BigInt(Number.MAX_SAFE_INTEGER))||maximum===undefined||maximum!==null&&(!/^-?\d+$/.test(maximum)||BigInt(maximum)>=BigInt(Number.MAX_SAFE_INTEGER)))throw new Error('Invalid or unsafe target sequence state.');
 }

}
/** Monotonic, atomic and repeatable. Never create a fake business row to advance
 * a counter, and never lower an existing counter or the maximum imported ID. */
export async function restoreSequenceTargets(database:D1Database,plan:SequenceRestore[],archive:string){
 const statements=plan.flatMap(entry=>{
  const maximum=`coalesce((SELECT max(${quote(entry.column)}) FROM ${quote(entry.table)}),0)`;
  return [
   database.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM migration_imports WHERE id='common' AND archive_sha256=? AND status='importing_common') THEN 1 ELSE json('IMPORT_SEQUENCE_FENCE') END").bind(archive),
   database.prepare('SELECT CASE WHEN (SELECT count(*) FROM sqlite_sequence WHERE name=?)<=1 THEN 1 ELSE json(\'IMPORT_SEQUENCE_DUPLICATE\') END').bind(entry.table),
   database.prepare(`UPDATE sqlite_sequence SET seq=max(seq,CAST(? AS INTEGER),${maximum}) WHERE name=?`).bind(entry.floor,entry.table),
   database.prepare(`INSERT INTO sqlite_sequence(name,seq) SELECT ?,max(CAST(? AS INTEGER),${maximum}) WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=?)`).bind(entry.table,entry.floor,entry.table),
   database.prepare(`SELECT CASE WHEN (SELECT count(*) FROM sqlite_sequence WHERE name=?)=1 AND EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=? AND typeof(seq)='integer' AND seq>=? AND seq>=${maximum} AND seq<9007199254740991) THEN 1 ELSE json('IMPORT_SEQUENCE_UNSAFE') END`).bind(entry.table,entry.table,entry.floor),
  ];
 });
 // Five statements per counter remain together in each atomic request.
 await migrationBatches(database,statements,25);
}
