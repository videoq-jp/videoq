import type pg from 'pg';
import type {SequenceState} from './sequence-format';
import {ARCHIVE_VERSION} from './archive-format';
import {createHash} from 'node:crypto';
import {open,mkdtemp,link,rm,lstat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {importReadSnapshot} from '../../../src/persistence/postgres/read-snapshot';
import {buildMigrationManifest,convertMigrationValue,migrationSelectExpression,quoteMigrationIdentifier as quote} from './manifest';
type Manifest=ReturnType<typeof buildMigrationManifest>;
type Column={name:string;type:string};
type Table={schema:string;name:string;columns:Column[];mode:'converted'|'raw-special'};
const canonical=(type:string)=>type.replace(/^character varying/,'varchar').replace(/^public\./,'');
/** Archive data, not SQL. No target writes and no source row data in diagnostics.
 * The private archive includes credentials and must be handled like a DB backup.
 */
export async function exportPostgresArchive(client:pg.Client|pg.PoolClient,manifest:Manifest,output:string,options:{schema?:string;fetchRows?:number;statementTimeoutMs?:number;snapshot?:string}={}){
 const schema=options.schema??'public',fetchRows=options.fetchRows??10,timeout=options.statementTimeoutMs??60000;
 if(!manifest.mapping_complete)throw new Error('Migration mapping is incomplete.');
 if(!output.endsWith('.videoq-export.ndjson'))throw new Error('Archive filename must end in .videoq-export.ndjson.');
 if(!Number.isSafeInteger(fetchRows)||fetchRows<1||fetchRows>200)throw new Error('Invalid export page size.');
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>3600000)throw new Error('Invalid export timeout.');
 quote(schema);
 try{await lstat(output);throw new Error('Archive output already exists.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 let stage:string|undefined,transaction=false;
 try{
  if(options.snapshot!==undefined)await importReadSnapshot(client,options.snapshot);
  else await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  transaction=true;
  await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','60000',true),set_config('DateStyle','ISO, YMD',true),set_config('TimeZone','UTC',true),set_config('extra_float_digits','3',true)",[String(timeout)]);
  const tables:Table[]=[],auxiliaryInventory=[];
  for(const sourceSchema of [schema,...manifest.auxiliary_sources.map(source=>source.schema)]){
   const found=(await client.query<{name:string}>("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p','f','m') ORDER BY c.relname",[sourceSchema])).rows;
   const expected=sourceSchema===schema?manifest.tables.map(table=>table.source):manifest.auxiliary_sources.find(source=>source.schema===sourceSchema)!.tables;
   if(sourceSchema===schema&&(found.length!==expected.length||found.some(table=>!expected.includes(table.name))))throw new Error('Live source table coverage differs from migration manifest.');
   if(sourceSchema!==schema&&found.some(table=>!expected.includes(table.name)))throw new Error('Unknown auxiliary source table.');
   if(sourceSchema!==schema&&found.length!==0&&found.length!==expected.length)throw new Error('Incomplete auxiliary source schema.');
   if(sourceSchema!==schema)auxiliaryInventory.push({schema:sourceSchema,tables:found.map(table=>table.name)});
   for(const table of found){
    const columns=(await client.query<Column>("SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",[sourceSchema,table.name])).rows;
    const plan=sourceSchema===schema?manifest.tables.find(entry=>entry.source===table.name):undefined;
    if(plan?.policy==='convert_rows'&&(columns.length!==plan.columns.length||columns.some(column=>!plan.columns.some(planned=>planned.name===column.name&&canonical(planned.source_type)===canonical(column.type)))))throw new Error('Live source column coverage differs from migration manifest.');
    tables.push({schema:sourceSchema,name:table.name,columns,mode:plan?.policy==='convert_rows'?'converted':'raw-special'});
   }
  }
  if(tables.some(table=>table.schema===schema&&table.name==='chat_conversations')&&auxiliaryInventory.some(entry=>entry.schema==='chat_memory'&&entry.tables.length===0)){
   if((await client.query(`SELECT 1 FROM ${quote(schema)}.chat_conversations WHERE committed_checkpoint_id IS NOT NULL LIMIT 1`)).rowCount)throw new Error('Committed conversations require the checkpoint source schema.');
  }
  const historyExists=(await client.query<{present:boolean}>("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0].present;
  const migrationHistory=historyExists?(await client.query("SELECT id,hash,created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id")).rows:null;
  const sequences:SequenceState[]=[];
  const names=(await client.query<Omit<SequenceState,'schema'|'last_value'|'is_called'>>(`SELECT s.sequencename AS name,s.increment_by::text AS increment_by,s.min_value::text AS min_value,s.max_value::text AS max_value,s.cache_size::text AS cache_size,s.cycle,
   tn.nspname AS owner_schema,t.relname AS owner_table,a.attname AS owner_column
   FROM pg_sequences s JOIN pg_namespace sn ON sn.nspname=s.schemaname JOIN pg_class sc ON sc.relnamespace=sn.oid AND sc.relname=s.sequencename
   LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=sc.oid AND d.refclassid='pg_class'::regclass AND d.refobjsubid>0 AND d.deptype IN('a','i')
   LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
   WHERE s.schemaname=$1 ORDER BY s.sequencename`,[schema])).rows;
  for(const sequence of names){const row=(await client.query<{last_value:string;is_called:boolean}>(`SELECT last_value::text AS last_value,is_called FROM ${quote(schema)}.${quote(sequence.name)}`)).rows[0];sequences.push({schema,...sequence,...row});}

  stage=await mkdtemp(join(dirname(output),'.videoq-d1-export-'));const file=await open(join(stage,'archive'),'wx',0o600);
  const hash=createHash('sha256'),counts=[];
  const write=async(record:unknown)=>{const line=JSON.stringify(record)+'\n';await file.writeFile(line);hash.update(line);};
  try{
   await write({kind:'archive_start',version:ARCHIVE_VERSION,source_schema:schema,created_at:new Date().toISOString(),snapshot:'repeatable-read/read-only',mapping_sha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),execution_complete:false,sequences,migration_history:migrationHistory,auxiliary_inventory:auxiliaryInventory,auxiliary_sources:manifest.auxiliary_sources,limitations:['Sequence state is observational and is not MVCC-isolated; final cutover requires stopped/drained writers.','Raw special tables require explicit Vectorize/checkpoint/visual conversion before import.','This artifact is not a completed migration or a restorable PostgreSQL backup.']});
   for(const table of tables){
    const plan=table.mode==='converted'?manifest.tables.find(entry=>entry.source===table.name)!:undefined;
    const keys=(await client.query<{name:string}>("SELECT a.attname AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ANY(i.indkey) WHERE n.nspname=$1 AND c.relname=$2 AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)",[table.schema,table.name])).rows.map(row=>row.name);
    const projection=table.columns.map(column=>column.type==='bytea'?`pg_catalog.encode(${quote(column.name)},'hex') AS ${quote(column.name)}`:migrationSelectExpression({name:column.name,type:canonical(column.type)})).join(',');
    await write({kind:'table_start',schema:table.schema,table:table.name,mode:table.mode,columns:table.columns.map(column=>({...column,encoding:plan?plan.columns.find(entry=>entry.name===column.name)!.conversion:column.type==='bytea'?'hex':'postgres-text'})),primary_key:keys});
    await client.query(`DECLARE videoq_export_cursor NO SCROLL CURSOR FOR SELECT ${projection} FROM ${quote(table.schema)}.${quote(table.name)} ORDER BY ${keys.length?keys.map(quote).join(','):'ctid'}`);
    const tableHash=createHash('sha256');let count=0n;
    for(;;){
     const rows=(await client.query<Record<string,string|null>>(`FETCH FORWARD ${fetchRows} FROM videoq_export_cursor`)).rows;if(!rows.length)break;
     for(const row of rows){
      const values=table.columns.map(column=>{if(!plan)return row[column.name];const mapped=plan.columns.find(entry=>entry.name===column.name)!;if(!mapped.conversion)throw new Error('Unsupported row conversion.');return convertMigrationValue(row[column.name],mapped.conversion,mapped.nullable);});
      const record={kind:'row',values},line=JSON.stringify(record)+'\n';tableHash.update(line);await write(record);count++;
     }
    }
    await client.query('CLOSE videoq_export_cursor');
    const summary={schema:table.schema,table:table.name,rows:count.toString(),sha256:tableHash.digest('hex')};counts.push(summary);await write({kind:'table_end',...summary});
   }
   await client.query('COMMIT');transaction=false;
   await file.writeFile(JSON.stringify({kind:'archive_end',tables:counts,sha256:hash.digest('hex'),execution_complete:false})+'\n');await file.sync();
  }finally{await file.close();}
  await link(join(stage,'archive'),output);
  return {tables:counts.length,rows:counts.reduce((sum,table)=>sum+BigInt(table.rows),0n).toString()};
 }catch(error){if(transaction)await client.query('ROLLBACK');throw error;}
 finally{if(stage)await rm(stage,{recursive:true,force:true});}
}
