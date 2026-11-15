import {createHash} from 'node:crypto';
import type pg from 'pg';
import {JsonPlusSerializer} from '@langchain/langgraph-checkpoint';
import {buildMigrationManifest,convertMigrationValue,quoteMigrationIdentifier as q,type Conversion} from './manifest';
export type RecoveryRows=Record<string,Record<string,unknown>[]>;
type Manifest=ReturnType<typeof buildMigrationManifest>;
export type RecoveryVector={id:string;values:number[];metadata:Record<string,unknown>};
export class PostwriteRecoveryError extends Error {readonly name='PostwriteRecoveryError';}
const fail=(message:string):never=>{throw new PostwriteRecoveryError(message);};
const text=(v:unknown):string=>typeof v==='string'?v:fail('Expected recovery text.');
const integer=(v:unknown):number=>typeof v==='number'&&Number.isSafeInteger(v)?v:fail('Expected safe recovery integer.');
/** Inverse of the existing forward conversion. Values remain parameterized. */
export function reverseMigrationValue(v:unknown,rule:Conversion,nullable:boolean):string|number|boolean|null|string[]{
 if(v===null)return nullable?null:fail('Unexpected recovery NULL.');
 if(rule==='safe_integer')return integer(v);
 if(rule==='boolean_integer'){if(v!==0&&v!==1)fail('Invalid recovery boolean.');return v===1;}
 if(rule==='finite_real')return typeof v==='number'&&Number.isFinite(v)?v:fail('Invalid recovery real.');
 if(rule==='text_array_json'){const a:unknown=JSON.parse(text(v));if(!Array.isArray(a)||a.some(x=>typeof x!=='string'&&x!==null))fail('Invalid recovery text array.');return a as string[];}
 return convertMigrationValue(v,rule,nullable);
}
const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):v;
export const recoveryHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
class JsonNumber {constructor(readonly token:string){}}
/** Typed canonical tree preserves arbitrary JSON numeric lexemes while treating
 * JSONB whitespace/key-order/decimal spelling changes as equivalent. */
export function canonicalRecoveryJson(source:string):unknown{
 const parse=JSON.parse as (s:string,r:(k:string,v:unknown,c?:{source?:string})=>unknown)=>unknown;
 const value=parse(source,(_key,v,c)=>typeof v==='number'?new JsonNumber(c?.source??fail('JSON source tokens unavailable.')):v);
 const visit=(v:unknown):unknown=>{
  if(v instanceof JsonNumber){const m=/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(v.token);if(!m)fail('Invalid JSON numeric token.');const [,sign,whole,fraction='',power='0']=m!;let digits=(whole+fraction).replace(/^0+/,'');if(!digits)return ['number','0'];const trimmed=digits.replace(/0+$/,'');const exponent=BigInt(power)-BigInt(fraction.length)+BigInt(digits.length-trimmed.length);digits=trimmed;return ['number',sign+digits+'e'+exponent];}
  if(v===null)return ['null'];if(Array.isArray(v))return ['array',v.map(visit)];if(typeof v==='object')return ['object',Object.entries(v as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,visit(v)])];return [typeof v,v];
 };return visit(value);
}
function normalized(v:unknown,rule:Conversion){if(v===null)return null;return rule==='json_text'||rule==='text_array_json'?canonicalRecoveryJson(text(v)):v;}

/** Bounded rehearsal primitive, NOT a production rollback CLI. It refuses remote
 * PG, public schemas, active work, unknown coverage and unsupported visual refs.
 * Writers must be externally fenced; two reads alone do not establish a fence. */
export async function restorePostwriteSnapshot(o:{client:pg.Client;schema:string;checkpointSchema:string;manifest:Manifest;rows:RecoveryRows;vectors:RecoveryVector[];writersFenced:boolean}){
 const {client,schema,checkpointSchema,manifest,rows}=o;
 if(!o.writersFenced||!/^recovery_[a-f0-9]{32}$/.test(schema)||!/^recovery_[a-f0-9]{32}_chat$/.test(checkpointSchema)||checkpointSchema!==schema+'_chat')fail('Isolated recovery schemas and stopped writers required.');
 const host=(client as unknown as {connectionParameters:{host:string}}).connectionParameters.host;
 if(!['localhost','127.0.0.1','::1'].includes(host))fail('Only local rehearsal PostgreSQL is allowed.');
 if(!manifest.mapping_complete)fail('Incomplete schema mapping.');
 const names=manifest.target_insert_order;
 if(Object.keys(rows).length!==names.length||names.some(n=>!Array.isArray(rows[n]))||Object.keys(rows).some(n=>!names.includes(n)))fail('Snapshot inventory mismatch.');
 if(Object.values(rows).some(r=>r.length>1000)||Buffer.byteLength(JSON.stringify(rows))>16*1024*1024)fail('Synthetic rehearsal budget exceeded.');
 if(rows.mutation_receipts.length||rows.scene_staging.length||rows.scene_index_tasks.some(r=>!r.completed_at||r.lease_token)||rows.scene_index_runs.some(r=>r.status!=='published'||r.pending_vectors!==0)||rows.visual_object_attempts.length)fail('Index or transient work is not quiescent.');
 if(rows.ai_answer_attempts.some(r=>r.status==='started')||rows.job_executions.some(r=>r.status==='running'||r.lease_token!==null)||rows.external_tasks.some(r=>(!r.completed_at&&!r.dead_at)||r.locked_at!==null)||rows.chat_conversations.some(r=>r.lease_id!==null||r.leased_until!==null))fail('Business work is not quiescent.');
 if(rows.video_course_invitations.some(r=>r.creation_nonce!==null))fail('Invitation creation is not quiescent.');
 if(rows.video_visual_chunks.some(r=>r.object_version!==null)||rows.video_visual_runs.some(r=>r.publication_version!==null))fail('Versioned visual objects need a separately verified downgrade plan.');
 const common=manifest.tables.filter(t=>t.target!==null),order=names.filter(n=>common.some(t=>t.source===n));
 const plans=order.map(name=>{const table=common.find(t=>t.source===name)!;return {name,columns:table.columns,values:rows[name].map(row=>table.columns.map(c=>reverseMigrationValue(row[c.name],c.conversion!,c.nullable)))};});
 const owner=new Map(rows.videos.map(r=>[integer(r.id),text(r.user_id)]));
 const vectors=new Map(o.vectors.map(v=>[v.id,v]));if(vectors.size!==o.vectors.length)fail('Duplicate recovery vector.');
 const scenes=rows.scenes.map(s=>{
  const dimensions=integer(s.dimensions),user=owner.get(integer(s.video_id)),id=text(s.id),physical=s.vector_id===null?id:text(s.vector_id),v=vectors.get(physical);
  const head=rows.video_index_heads.find(h=>h.video_id===s.video_id&&h.dimensions===dimensions),run=rows.scene_index_runs.find(r=>r.id===head?.run_id),revision=rows.video_index_versions.find(r=>r.video_id===s.video_id)?.revision;
  if(!user||![768,1536].includes(dimensions)||!run||run.source_revision!==s.revision||revision!==s.revision||run.user_id!==user||run.video_id!==s.video_id||run.dimensions!==dimensions)fail('Scene publication or ownership mismatch.');
  if(!v||v.values.length!==dimensions||!v.values.every(x=>Number.isFinite(x)&&Number.isFinite(Math.fround(x)))||!v.values.some(x=>Math.fround(x)!==0)||v.metadata.user_id!==user||v.metadata.video_id!==s.video_id||v.metadata.vector_id!==physical||v.metadata.revision!==s.revision)fail('Missing, invalid or unauthorized recovery vector.');
  convertMigrationValue(id,'uuid',false);
  return {table:dimensions===1536?'scene_embeddings':'scene_embeddings_768',values:[id,s.content,JSON.stringify(v!.values),user,s.video_id,JSON.stringify({user_id:user,video_id:s.video_id,start_time:s.start_time,end_time:s.end_time,evidence_type:s.evidence_type})]};
 });
 for(const r of rows.scene_index_runs){const h=rows.video_index_heads.find(h=>h.run_id===r.id);if(h&&rows.scenes.filter(s=>s.video_id===r.video_id&&s.dimensions===r.dimensions).length!==r.expected_scenes)fail('Published scene count mismatch.');}
 const serde=new JsonPlusSerializer();
 const decode=async(type:unknown,value:unknown)=>{if(type!=='json'&&type!=='bytes')fail('Unsupported checkpoint encoding.');if(!Array.isArray(value)||value.some(x=>!Number.isInteger(x)||Number(x)<0||Number(x)>255))fail('Invalid checkpoint bytes.');return await serde.loadsTyped(text(type),Uint8Array.from(value as number[])) as unknown;};
 const checkpoints=[];
 for(const r of rows.conversation_checkpoints){const cp=await decode(r.checkpoint_type,r.checkpoint) as Record<string,unknown>,metadata=await decode(r.metadata_type,r.metadata);if(cp.id!==r.checkpoint_id||!rows.chat_conversations.some(c=>c.thread_id===r.thread_id))fail('Checkpoint ownership or identity mismatch.');checkpoints.push({row:r,cp,metadata});}
 for(const c of rows.chat_conversations)if(c.committed_checkpoint_id!==null&&!checkpoints.some(x=>x.row.thread_id===c.thread_id&&x.row.namespace===''&&x.cp.id===c.committed_checkpoint_id))fail('Committed checkpoint is missing.');
 const writes=[];for(const r of rows.conversation_checkpoint_writes){await decode(r.value_type,r.value);if(!checkpoints.some(c=>c.row.thread_id===r.thread_id&&c.row.namespace===r.namespace&&c.cp.id===r.checkpoint_id))fail('Pending write checkpoint missing.');writes.push(r);}
 const qualified=(name:string)=>q(schema)+'.'+q(name),chat=(name:string)=>q(checkpointSchema)+'.'+q(name);
 await client.query('BEGIN');
 try{
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
  // No CASCADE: unknown references fail and roll back, preserving old rows.
  await client.query('LOCK TABLE '+[...order,'scene_embeddings','scene_embeddings_768'].map(qualified).join(',')+' IN ACCESS EXCLUSIVE MODE');
  for(const n of ['checkpoint_writes','checkpoint_blobs','checkpoints'])await client.query('DELETE FROM '+chat(n));
  for(const n of ['scene_embeddings','scene_embeddings_768',...order.toReversed()])await client.query('DELETE FROM '+qualified(n));
  for(const p of plans)for(const values of p.values)await client.query('INSERT INTO '+qualified(p.name)+' ('+p.columns.map(c=>q(c.name)).join(',')+') VALUES ('+values.map((_,i)=>'$'+(i+1)).join(',')+')',values);
  for(const s of scenes)await client.query('INSERT INTO '+qualified(s.table)+' (langchain_id,content,embedding,user_id,video_id,langchain_metadata) VALUES ($1,$2,$3,$4,$5,$6)',s.values);
  const blobIdentities=new Map<string,string>();
  for(const {row:r,cp,metadata} of checkpoints){
   const versions=cp.channel_versions as Record<string,string|number>,values=cp.channel_values as Record<string,unknown>;if(!versions||!values)fail('Invalid checkpoint channels.');
   for(const [channel,version] of Object.entries(versions)){
    if(typeof version!=='string'&&!(typeof version==='number'&&Number.isFinite(version)))fail('Invalid checkpoint channel version.');
    const [type,data]=Object.hasOwn(values,channel)?await serde.dumpsTyped(values[channel]):['empty',null] as const;
    const pgVersion=typeof version==='string'?version:(await client.query<{version:string}>("SELECT $1::jsonb #>> '{}' AS version",[JSON.stringify(version)])).rows[0].version;
    const key=JSON.stringify([r.thread_id,r.namespace,channel,pgVersion]),hash=recoveryHash([type,data?Array.from(data):null]);if(blobIdentities.has(key)&&blobIdentities.get(key)!==hash)fail('Conflicting checkpoint channel versions.');blobIdentities.set(key,hash);
    await client.query('INSERT INTO '+chat('checkpoint_blobs')+' (thread_id,checkpoint_ns,channel,version,type,blob) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[r.thread_id,r.namespace,channel,pgVersion,type,data?Buffer.from(data):null]);
   }
   const payload={...cp};delete payload.channel_values;
   await client.query('INSERT INTO '+chat('checkpoints')+' (thread_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,checkpoint,metadata) VALUES ($1,$2,$3,$4,$5,$6)',[r.thread_id,r.namespace,r.checkpoint_id,r.parent_id,JSON.stringify(payload),JSON.stringify(metadata)]);
  }
  for(const r of writes)await client.query('INSERT INTO '+chat('checkpoint_writes')+' (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,task_path,channel,type,blob) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[r.thread_id,r.namespace,r.checkpoint_id,r.task_id,r.idx,r.task_path,r.channel,r.value_type,Buffer.from(r.value as number[])]);
  const verified=[];
  for(const p of plans){
   const table=common.find(t=>t.source===p.name)!;
   const expressions=p.columns.map(c=>(c.source_type==='text[]'?'to_json('+q(c.name)+')':q(c.name))+'::text AS '+q(c.name));
   const actual=(await client.query<Record<string,unknown>>('SELECT '+expressions.join(',')+' FROM '+qualified(p.name))).rows.map(r=>table.columns.map(c=>normalized(convertMigrationValue(r[c.name],c.conversion!,c.nullable),c.conversion!)));
   const expected=rows[p.name].map(r=>table.columns.map(c=>normalized(r[c.name],c.conversion!)));
   const digest=(v:unknown[])=>recoveryHash(v.map(v=>JSON.stringify(stable(v))).sort());if(digest(actual)!==digest(expected))fail('Recovered table equality check failed.');verified.push({table:p.name,rows:actual.length,sha256:digest(actual)});
  }
  // ALTER SEQUENCE RESTART participates in this transaction; setval would not.
  for(const p of plans)for(const c of p.columns){const sequence=(await client.query<{name:string|null}>('SELECT pg_get_serial_sequence($1,$2) AS name',[qualified(p.name),c.name])).rows[0].name;if(sequence){const maximum=(await client.query<{value:string|null}>('SELECT max('+q(c.name)+')::text AS value FROM '+qualified(p.name))).rows[0].value;const seq=(await client.query<{nspname:string;relname:string}>('SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=$1::regclass',[sequence])).rows[0];if(seq.nspname!==schema)fail('Sequence is outside the isolated schema.');await client.query('ALTER SEQUENCE '+q(seq.nspname)+'.'+q(seq.relname)+' RESTART WITH '+(maximum===null?'1':String(BigInt(maximum)+1n)));}}
  await client.query('COMMIT');return {commonTables:verified,scenes:scenes.length,checkpoints:checkpoints.length,pendingWrites:writes.length,sha256:recoveryHash(verified),productionSafe:false};
 }catch{await client.query('ROLLBACK');throw new PostwriteRecoveryError('Recovery transaction failed; isolated target must remain offline.');}
}
