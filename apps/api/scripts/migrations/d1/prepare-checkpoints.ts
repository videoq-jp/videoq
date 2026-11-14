import {DatabaseSync} from 'node:sqlite';
import {chmod,open} from 'node:fs/promises';
import {join} from 'node:path';
import {JsonPlusSerializer,type Checkpoint} from '@langchain/langgraph-checkpoint';
import {D1_CHECKPOINT_MAX_BYTES} from '../../../src/persistence/d1/checkpoint-limits';
import type {PreparedTable,PreparedSpecialTable} from './prepare-import';
import type {buildMigrationManifest} from './manifest';
import {convertMigrationValue} from './manifest';
import {readArchiveLines} from './verify-archive';
export type PreparedCheckpointTable=PreparedTable&{binary_columns:number[]};
export class CheckpointMigrationError extends Error {readonly name='CheckpointMigrationError';}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const required=(value:unknown)=>{if(typeof value!=='string')throw new CheckpointMigrationError('Checkpoint source text is missing.');return value;};
const nonempty=(value:unknown)=>{const text=required(value);if(!text)throw new CheckpointMigrationError('Checkpoint identity is missing.');return text;};
const binary=(value:unknown)=>{const text=required(value);if(!/^(?:[0-9a-f]{2})*$/.test(text))throw new CheckpointMigrationError('Invalid checkpoint binary encoding.');return Uint8Array.from(Buffer.from(text,'hex'));};
class NumericToken{constructor(readonly source:string){}}
/** Use the PostgreSQL JSONB numeric lexeme as the blob-version key, matching
 * jsonb_each_text; JS Number.toString can use a different exponent spelling. */
function versions(text:string){
 const parse=JSON.parse as (text:string,reviver:(key:string,value:unknown,context?:{source?:string})=>unknown)=>unknown;
 const raw=parse(text,(_key,value,context)=>{if(typeof value!=='number')return value;if(!context?.source)throw new CheckpointMigrationError('Checkpoint migration requires JSON source-token support.');return new NumericToken(context.source);});
 if(!record(raw))throw new CheckpointMigrationError('Invalid checkpoint payload.');
 const entries=raw.channel_versions??{};if(!record(entries))throw new CheckpointMigrationError('Invalid channel version map.');
 return Object.entries(entries).map(([channel,value])=>{if(typeof value==='string')return [channel,value] as const;if(value instanceof NumericToken)return [channel,value.source] as const;throw new CheckpointMigrationError('Invalid checkpoint channel version.');});
}
const serializeLine=(values:unknown[])=>JSON.stringify({kind:'row',values})+'\n';
export async function prepareCheckpointImport(common:PreparedTable[],special:PreparedSpecialTable[],manifest:ReturnType<typeof buildMigrationManifest>,directory:string){
 const sourceSchema=manifest.auxiliary_sources.find(source=>source.policy==='convert_with_langgraph_serializer_and_validate_history')?.schema;
 const sources=special.filter(table=>table.schema===sourceSchema);
 const summary={source_checkpoints:'0',source_blobs:'0',source_writes:'0',source_migrations:'0',unused_blobs:'0'};
 if(!sources.length)return {tables:[] as PreparedCheckpointTable[],handled_source_rows:'0',summary};
 if(sources.length!==4)throw new CheckpointMigrationError('Incomplete checkpoint source tables.');
 const local=join(directory,'checkpoint-source.sqlite'),database=new DatabaseSync(local);await chmod(local,0o600);
 const serializer=new JsonPlusSerializer();
 try{
  database.exec(`BEGIN; CREATE TABLE threads(thread TEXT PRIMARY KEY,committed TEXT);
   CREATE TABLE checkpoints(thread TEXT,namespace TEXT,id TEXT,parent TEXT,payload TEXT,metadata TEXT,PRIMARY KEY(thread,namespace,id));
   CREATE TABLE blobs(thread TEXT,namespace TEXT,channel TEXT,version TEXT,type TEXT,data TEXT,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread,namespace,channel,version));
   CREATE TABLE writes(thread TEXT,namespace TEXT,id TEXT,task TEXT,idx INTEGER,path TEXT,channel TEXT,type TEXT,data TEXT,PRIMARY KEY(thread,namespace,id,task,idx));
   CREATE TABLE migrations(v INTEGER PRIMARY KEY);`);
  const threads=common.find(table=>table.name==='chat_conversations');
  if(threads){const insert=database.prepare('INSERT INTO threads VALUES(?,?)');for await(const line of readArchiveLines(threads.path)){const row=JSON.parse(line.toString()) as {values:(string|number|null)[]};insert.run(nonempty(row.values[threads.columns.indexOf('thread_id')]),row.values[threads.columns.indexOf('committed_checkpoint_id')]??null);}}
  for(const table of sources){
   const requiredColumns=table.name==='checkpoints'?['thread_id','checkpoint_ns','checkpoint_id','parent_checkpoint_id','checkpoint','metadata']:table.name==='checkpoint_blobs'?['thread_id','checkpoint_ns','channel','version','type','blob']:table.name==='checkpoint_writes'?['thread_id','checkpoint_ns','checkpoint_id','task_id','idx','channel','type','blob']:table.name==='checkpoint_migrations'?['v']:[];
   const allowed=[...requiredColumns,...(table.name==='checkpoints'?['type']:table.name==='checkpoint_writes'?['task_path']:[])];
   if(!requiredColumns.length||requiredColumns.some(name=>!table.columns.includes(name))||table.columns.some(name=>!allowed.includes(name)))throw new CheckpointMigrationError('Unsupported checkpoint source columns.');
   const statement=database.prepare(table.name==='checkpoints'?'INSERT INTO checkpoints VALUES(?,?,?,?,?,?)':table.name==='checkpoint_blobs'?'INSERT INTO blobs(thread,namespace,channel,version,type,data) VALUES(?,?,?,?,?,?)':table.name==='checkpoint_writes'?'INSERT INTO writes VALUES(?,?,?,?,?,?,?,?,?)':'INSERT INTO migrations VALUES(?)');
   for await(const line of readArchiveLines(table.path)){
    const {values}=JSON.parse(line.toString()) as {values:(string|null)[]};const get=(name:string)=>values[table.columns.indexOf(name)];
    if(table.name==='checkpoint_migrations'){const v=convertMigrationValue(get('v'),'safe_integer',false) as number;if(v<0||v>5)throw new CheckpointMigrationError('Unsupported checkpoint schema migration.');statement.run(v);continue;}
    const thread=nonempty(get('thread_id')),namespace=required(get('checkpoint_ns'));
    if(table.name==='checkpoints')statement.run(thread,namespace,nonempty(get('checkpoint_id')),get('parent_checkpoint_id')??null,required(get('checkpoint')),required(get('metadata')));
    else if(table.name==='checkpoint_blobs')statement.run(thread,namespace,required(get('channel')),required(get('version')),required(get('type')),get('blob'));
    else statement.run(thread,namespace,nonempty(get('checkpoint_id')),nonempty(get('task_id')),convertMigrationValue(get('idx'),'safe_integer',false) as number,get('task_path')??'',required(get('channel')),required(get('type')),required(get('blob')));
   }
  }
  const count=(table:string)=>String((database.prepare('SELECT CAST(count(*) AS TEXT) AS count FROM '+table).get() as {count:string}).count);
  summary.source_checkpoints=count('checkpoints');summary.source_blobs=count('blobs');summary.source_writes=count('writes');summary.source_migrations=count('migrations');
  const migrationVersions=database.prepare('SELECT v FROM migrations ORDER BY v').all() as {v:number}[];
  if(migrationVersions.some((row,index)=>row.v!==index)||(!migrationVersions.length&&(summary.source_checkpoints!=='0'||summary.source_writes!=='0'||summary.source_blobs!=='0')))throw new CheckpointMigrationError('Incomplete checkpoint schema history.');
  if(database.prepare('SELECT 1 FROM checkpoints c LEFT JOIN threads t ON t.thread=c.thread WHERE t.thread IS NULL LIMIT 1').get()||database.prepare('SELECT 1 FROM writes w LEFT JOIN threads t ON t.thread=w.thread WHERE t.thread IS NULL LIMIT 1').get())throw new CheckpointMigrationError('Checkpoint thread ownership is missing.');
  if(database.prepare("SELECT 1 FROM threads t WHERE committed IS NOT NULL AND NOT EXISTS(SELECT 1 FROM checkpoints c WHERE c.thread=t.thread AND c.namespace='' AND c.id=t.committed) LIMIT 1").get())throw new CheckpointMigrationError('Committed conversation checkpoint is missing.');
  const tables:PreparedCheckpointTable[]=[{name:'conversation_checkpoints',columns:['thread_id','namespace','checkpoint_id','parent_id','checkpoint_type','checkpoint','metadata_type','metadata'],binary_columns:[5,7],path:join(directory,'prepared-checkpoints'),rows:summary.source_checkpoints},{name:'conversation_checkpoint_writes',columns:['thread_id','namespace','checkpoint_id','task_id','idx','task_path','channel','value_type','value'],binary_columns:[8],path:join(directory,'prepared-checkpoint-writes'),rows:summary.source_writes}];
  for(const table of tables){const file=await open(table.path,'wx',0o600);try{
   if(table.name==='conversation_checkpoints'){
    const lookup=database.prepare('SELECT type,data FROM blobs WHERE thread=? AND namespace=? AND channel=? AND version=?'),used=database.prepare('UPDATE blobs SET used=1 WHERE thread=? AND namespace=? AND channel=? AND version=?');
    for(const raw of database.prepare('SELECT * FROM checkpoints ORDER BY thread,namespace,id').iterate()){
     const row=raw as unknown as {thread:string;namespace:string;id:string;parent:string|null;payload:string;metadata:string},checkpoint:unknown=JSON.parse(row.payload);
     if(!record(checkpoint)||checkpoint.id!==row.id||!Number.isInteger(checkpoint.v)||Number(checkpoint.v)<1||Number(checkpoint.v)>4)throw new CheckpointMigrationError('Unsupported checkpoint identity or version.');
     const channelValues:[string,unknown][]=[];
     for(const [channel,version] of versions(row.payload)){
      const blob=lookup.get(row.thread,row.namespace,channel,version) as {type:string;data:string|null}|undefined;
      if(!blob)throw new CheckpointMigrationError('Referenced checkpoint channel blob is missing.');used.run(row.thread,row.namespace,channel,version);
      if(blob.type==='empty'){if(blob.data!==null)throw new CheckpointMigrationError('Invalid empty channel blob.');continue;}
      if(blob.type!=='json'&&blob.type!=='bytes')throw new CheckpointMigrationError('Unsupported checkpoint serializer.');
      channelValues.push([channel,await serializer.loadsTyped(blob.type,binary(blob.data))]);
     }
     const restored={...checkpoint,channel_versions:checkpoint.channel_versions??{},versions_seen:checkpoint.versions_seen??{},channel_values:Object.fromEntries(channelValues)} as unknown as Checkpoint;
     const [checkpointType,payload]=await serializer.dumpsTyped(restored),[metadataType,metadata]=await serializer.dumpsTyped(await serializer.loadsTyped('json',row.metadata));
     if(payload.byteLength+metadata.byteLength+Buffer.byteLength(JSON.stringify([row.thread,row.namespace,row.id,row.parent]))>D1_CHECKPOINT_MAX_BYTES)throw new CheckpointMigrationError('Checkpoint exceeds target row budget.');
     await file.writeFile(serializeLine([row.thread,row.namespace,row.id,row.parent,checkpointType,Buffer.from(payload).toString('hex'),metadataType,Buffer.from(metadata).toString('hex')]));
    }
   }else for(const raw of database.prepare('SELECT * FROM writes ORDER BY thread,namespace,id,task,idx').iterate()){
    const row=raw as unknown as {thread:string;namespace:string;id:string;task:string;idx:number;path:string;channel:string;type:string;data:string};
    if(row.type!=='json'&&row.type!=='bytes')throw new CheckpointMigrationError('Unsupported pending-write serializer.');const data=binary(row.data);await serializer.loadsTyped(row.type,data);
    if(data.byteLength+Buffer.byteLength(JSON.stringify([row.thread,row.namespace,row.id,row.task,row.path,row.channel]))>D1_CHECKPOINT_MAX_BYTES)throw new CheckpointMigrationError('Pending write exceeds target row budget.');
    await file.writeFile(serializeLine([row.thread,row.namespace,row.id,row.task,row.idx,row.path,row.channel,row.type,row.data]));
   }
  }finally{await file.close();}}
  summary.unused_blobs=String((database.prepare('SELECT CAST(count(*) AS TEXT) AS count FROM blobs WHERE used=0').get() as {count:string}).count);
  database.exec('COMMIT');
  return {tables,handled_source_rows:sources.reduce((sum,table)=>sum+BigInt(table.rows),0n).toString(),summary};
 }catch(error){if(error instanceof CheckpointMigrationError)throw error;throw new CheckpointMigrationError('Checkpoint archive reconstruction failed.');}
 finally{database.close();}
}
