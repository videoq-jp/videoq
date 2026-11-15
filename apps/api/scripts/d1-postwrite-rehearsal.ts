import {writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {hashPassword,verifyPassword} from 'better-auth/crypto';
import {JsonPlusSerializer} from '@langchain/langgraph-checkpoint';
import {PostgresSaver} from '@langchain/langgraph-checkpoint-postgres';
import * as schema from '../src/db/schema';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest,quoteMigrationIdentifier as q} from './migrations/d1/manifest';
import {restorePostwriteSnapshot,recoveryHash,type RecoveryRows,type RecoveryVector} from './migrations/d1/postwrite-recovery';
import {readPrivateInput} from './migrations/d1/private-input';
type Configuration={accountId:string;databaseId:string;name:string;token:string;postgresUrl:string;expiresAt:string};
/** Destructive only to a newly empty, name-fenced synthetic D1 and fresh local
 * schemas. Caller owns provisioning/cleanup; no production URL is accepted. */
export async function main(args=process.argv.slice(2)){
 if(args.length!==4||args[0]!=='--config'||args[2]!=='--output')throw Error('Use --config <private synthetic config> --output <private receipt>.');
 const c=JSON.parse((await readPrivateInput(resolve(args[1]),65536)).toString()) as Configuration;
 if(!/^videoq-recovery-\d{8}-v\d+$/.test(c.name)||!/^[a-f0-9]{32}$/.test(c.accountId)||!/^[a-f0-9-]{36}$/.test(c.databaseId)||Date.parse(c.expiresAt)<Date.now()||Date.parse(c.expiresAt)>Date.now()+2*3600_000)throw Error('Invalid isolated execution target.');
 const url=new URL(c.postgresUrl);if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Local PostgreSQL required.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve(root,'drizzle')),await loadMigrationSnapshot(resolve(root,'drizzle-d1')));
 const cf=async(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>{if(Date.parse(c.expiresAt)<Date.now())throw Error('Execution expired.');const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+c.accountId+'/'+path,{method,headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});const x=await r.json<{success:boolean;result:unknown}>();if(!r.ok||!x.success)throw Error('Isolated Cloudflare request failed.');return x.result;};
 const info=await cf('d1/database/'+c.databaseId) as {name:string};assert.equal(info.name,c.name+'-db');
 const query=async(sql:string,params:unknown[]=[])=>{const x=await cf('d1/database/'+c.databaseId+'/query',{sql,params}) as {results:Record<string,unknown>[];success:boolean}[];assert(x.every(x=>x.success));return x.flatMap(x=>x.results);};
 const insert=async(name:string,row:Record<string,unknown>)=>{const keys=Object.keys(row);await query('INSERT INTO '+q(name)+' ('+keys.map(q).join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',Object.values(row));};
 const snapshot=async()=>{const names=manifest.target_insert_order;const result=await cf('d1/database/'+c.databaseId+'/query',{batch:names.map(name=>({sql:'SELECT * FROM '+q(name)+' LIMIT 1001'}))}) as {success:boolean;results:Record<string,unknown>[]}[];assert.equal(result.length,names.length);assert(result.every(r=>r.success));return Object.fromEntries<Record<string,unknown>[]>(names.map((name,i)=>[name,result[i].results]));};
 const catalog=await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*' AND name<>'d1_migrations'");assert.deepEqual(catalog.map(r=>r.name).sort(),manifest.target_insert_order.toSorted());
 assert.equal((await query('SELECT count(*) AS n FROM users'))[0].n,0);for(const r of Object.values(await snapshot()))assert.equal(r.length,0);
 const client=new pg.Client({connectionString:c.postgresUrl,application_name:'videoq-isolated-postwrite-recovery'}),name='recovery_'+randomUUID().replaceAll('-',''),chat=name+'_chat',saver=PostgresSaver.fromConnString(c.postgresUrl,{schema:chat});
 let created=false;const proof:Record<string,unknown>={version:1,syntheticOnly:true,productionModified:false,startedAt:new Date().toISOString(),checks:[]};
 const checks=proof.checks as string[];
 try{
  await client.connect();await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');await client.query('CREATE SCHEMA '+q(name));created=true;await client.query('SET search_path TO '+q(name)+',public');
  await client.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema))).map(sql=>sql.replaceAll('"public".','')).join('\n'));await saver.setup();
  for(let i=0;i<27;i++)await client.query('CREATE TABLE '+q(name)+'.'+q('legacy_archive_'+i)+' (id integer PRIMARY KEY,payload text NOT NULL); INSERT INTO '+q(name)+'.'+q('legacy_archive_'+i)+" VALUES(1,'archived-synthetic')");
  const legacy=async()=>{const data=[];for(let i=0;i<27;i++)data.push((await client.query('SELECT * FROM '+q(name)+'.'+q('legacy_archive_'+i))).rows);return recoveryHash(data);};const legacyBefore=await legacy();
  const owner='recovery-owner',other='recovery-other',deleted='recovery-deleted',timestamp='2026-11-15T00:00:00.123Z';
  for(const id of [owner,other,deleted])await insert('users',{id,name:id,username:id,email:id+'@example.invalid',email_verified:1,is_over_quota:0,used_ai_answers:0,used_processing_seconds:0,used_storage_bytes:0,created_at:timestamp,updated_at:timestamp});
  const password=await hashPassword('Synthetic recovery password 2026!');await insert('account',{id:'recovery-account',account_id:owner,user_id:owner,provider_id:'credential',password});
  await insert('session',{id:'recovery-session',user_id:owner,token:'synthetic-recovery-session-token',expires_at:'2099-01-01T00:00:00.000Z'});
  const video=async(id:number)=>insert('videos',{id,file:'synthetic-'+id+'.mp4',title:'Before cutover '+id,description:'日本語',uploaded_at:timestamp,transcript:'baseline',status:'completed',error_message:'',user_id:owner,source_type:'uploaded',source_url:'',youtube_video_id:''});
  await video(10);await video(11);await insert('video_courses',{id:10,user_id:owner,name:'Recovery course',description:'',created_at:timestamp,updated_at:timestamp,display_order:0});await insert('video_course_members',{course_id:10,video_id:10,added_at:timestamp,order:0});await insert('video_course_members',{course_id:10,video_id:11,added_at:timestamp,order:1});
  const restore=async(rows:RecoveryRows,vectors:RecoveryVector[]=[])=>{const states=await query('SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence');const high=Object.fromEntries(manifest.target_insert_order.map(n=>[n,(()=>{const v=states.find(s=>s.name===n)?.seq;if(v===undefined)return '0';assert.equal(typeof v,'string');return v as string;})()]));return restorePostwriteSnapshot({client,schema:name,checkpointSchema:chat,manifest,rows,vectors,writersFenced:true,sequenceHighWater:high});};
  await insert('account',{id:'deleted-account',account_id:deleted,user_id:deleted,provider_id:'credential',password});await insert('session',{id:'deleted-session',user_id:deleted,token:'synthetic-deleted-session',expires_at:'2099-01-01T00:00:00.000Z'});
  const baseline=await snapshot();proof.baseline=await restore(baseline);checks.push('precutover_baseline_restored');
  // Changes are made on the real D1 after the baseline copy exists in PG.
  await query("UPDATE users SET used_ai_answers=2,used_processing_seconds=15,used_storage_bytes=97964,used_upload_bytes=97964,billing_revision=7 WHERE id=?",[owner]);await query("UPDATE videos SET title='After D1 cutover',transcript='Backups are retained for thirty days.' WHERE id=10");
  await query('DELETE FROM users WHERE id=?',[deleted]);await query('DELETE FROM videos WHERE id=11');await video(50);await insert('video_course_members',{course_id:10,video_id:50,added_at:timestamp,order:2});
  await insert('job_executions',{job_id:'recovery-completed-job',job_type:'transcribe_video',payload_sha256:'a'.repeat(64),status:'completed',attempts:2,completed_at:timestamp});
  await insert('external_tasks',{id:20,kind:'sqs_job',payload:JSON.stringify({message:{job_id:'recovery-completed-job',payload:{video_id:50}}}).slice(0,-1)+',"large":9007199254740993}',dedupe_key:'recovery-job',completed_at:timestamp,attempts:1});
  await insert('lms_installations',{id:'recovery-lms',owner_user_id:owner,name:'Recovery LMS',issuer:'https://example.invalid',client_id:'synthetic',deployment_id:'synthetic',authorization_url:'https://example.invalid/auth',jwks_url:'https://example.invalid/jwks',materials_service:JSON.stringify({endpoint:'https://example.invalid/materials'})});
  const thread='recovery-thread',checkpoint='00000000-0000-4000-8000-000000000071';await insert('chat_conversations',{thread_id:thread,conversation_id:'00000000-0000-4000-8000-000000000072',owner_user_id:owner,actor_user_id:owner,course_id:10,committed_checkpoint_id:checkpoint,expires_at:'2099-01-01T00:00:00.000Z'});
  const cp={v:4,id:checkpoint,ts:timestamp,channel_values:{answer:'Thirty days',binary:new Uint8Array([1,2,255])},channel_versions:{answer:'1',binary:1e-7},versions_seen:{},pending_sends:[]},metadata={source:'input',step:1,parents:{}},serde=new JsonPlusSerializer();const [ct,cb]=await serde.dumpsTyped(cp),[mt,mb]=await serde.dumpsTyped(metadata),[wt,wb]=await serde.dumpsTyped({pending:'synthetic'});
  // D1 REST encodes BLOB input via SQL hex literal, not JSON array parameters.
  await query('INSERT INTO conversation_checkpoints(thread_id,namespace,checkpoint_id,parent_id,checkpoint_type,checkpoint,metadata_type,metadata) VALUES (?,\'\',?,NULL,?,X\''+Buffer.from(cb).toString('hex')+'\',?,X\''+Buffer.from(mb).toString('hex')+'\')',[thread,checkpoint,ct,mt]);
  await query('INSERT INTO conversation_checkpoint_writes(thread_id,namespace,checkpoint_id,task_id,idx,task_path,channel,value_type,value) VALUES (?,\'\',?,\'recovery-task\',0,\'0\',\'answer\',?,X\''+Buffer.from(wb).toString('hex')+'\')',[thread,checkpoint,wt]);
  const vectors:RecoveryVector[]=[];
  for(const dimensions of [768,1536]){
   const id=dimensions===768?'00000000-0000-4000-8000-000000000078':'00000000-0000-4000-8000-000000000079',physical='recovery-'+dimensions,revision=(dimensions===768?'b':'c').repeat(64),source='d'.repeat(64),run=revision,index=c.name+'-'+dimensions;
   if(dimensions===768)await insert('video_index_versions',{video_id:50,revision:source});await insert('scene_index_runs',{id:run,video_id:50,user_id:owner,source_revision:source,dimensions,expected_scenes:1,pending_vectors:0,status:'published'});await insert('video_index_heads',{video_id:50,dimensions,run_id:run});await insert('scenes',{id,video_id:50,content:'Thirty days of backups',start_time:'00:00:00,000',end_time:'00:00:15,000',evidence_type:'transcript',dimensions,revision,vector_id:physical});
   const vector={id:physical,values:Array.from({length:dimensions},(_,i)=>i===0?1:.01),metadata:{user_id:owner,video_id:50,vector_id:physical,revision}};
   // Real Vectorize payload is kept private; only hashes enter receipts.
   const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+c.accountId+'/vectorize/v2/indexes/'+index+'/upsert',{method:'POST',headers:{authorization:'Bearer '+c.token,'content-type':'application/x-ndjson'},body:JSON.stringify(vector)+'\n',signal:AbortSignal.timeout(30000)});assert(response.ok);const acknowledged=await response.json<{success:boolean}>();assert(acknowledged.success,'Vectorize upsert was not acknowledged');
   const until=Date.now()+120000;let found:RecoveryVector[]=[];do{found=await cf('vectorize/v2/indexes/'+index+'/get_by_ids',{ids:[physical]}) as RecoveryVector[];if(found.length)break;await new Promise(r=>setTimeout(r,2000));}while(Date.now()<until);assert.equal(found.length,1);vectors.push(found[0]);
  }
  const first=await snapshot(),second=await snapshot();assert.equal(recoveryHash(first),recoveryHash(second));proof.frozenSnapshotSha256=recoveryHash(second);checks.push('sole_writer_stopped_stable_d1_snapshot');
  // Verify fail-closed paths before any target replacement.
  const rejected=async(rows:RecoveryRows,v:RecoveryVector[]=vectors)=>{await assert.rejects(()=>restore(rows,v));};
  let bad=structuredClone(second);bad.job_executions[0].status='running';await rejected(bad);checks.push('active_job_rejected');
  bad=structuredClone(second);delete bad.users;await rejected(bad);checks.push('incomplete_inventory_rejected');
  const wrong=structuredClone(vectors);wrong[0].metadata.user_id=other;await rejected(second,wrong);await rejected(second,[]);checks.push('wrong_owner_and_missing_vector_rejected');
  bad=structuredClone(second);bad.video_visual_chunks.push({object_version:'unhandled'});await rejected(bad);checks.push('unsupported_visual_downgrade_rejected');
  // Deliberate UNIQUE violation after DELETE/INSERT begins must undo all changes.
  bad=structuredClone(second);bad.users[1].email=bad.users[0].email;await rejected(bad);assert.equal((await client.query<{title:string}>('SELECT title FROM '+q(name)+'.videos WHERE id=10')).rows[0].title,'Before cutover 10');assert.equal((await client.query<{n:number}>('SELECT count(*)::int AS n FROM '+q(name)+'.users')).rows[0].n,3);checks.push('mid_transaction_failure_preserved_baseline');
  proof.recovery=await restore(second,vectors);checks.push('all_56_common_tables_roundtrip_equal');
  assert.equal((await client.query<{n:number}>('SELECT count(*)::int AS n FROM '+q(name)+'.users WHERE id=$1',[deleted])).rows[0].n,0);assert.equal((await client.query<{n:number}>('SELECT count(*)::int AS n FROM '+q(name)+'.videos WHERE id=11')).rows[0].n,0);checks.push('user_and_video_deletions_reconciled');
  const auth=(await client.query<{password:string}>('SELECT password FROM '+q(name)+'.account WHERE id=$1',['recovery-account'])).rows[0];assert(await verifyPassword({hash:auth.password,password:'Synthetic recovery password 2026!'}));assert.equal((await client.query<{token:string}>('SELECT token FROM '+q(name)+'.session WHERE id=$1',['recovery-session'])).rows[0].token,'synthetic-recovery-session-token');assert.equal((await client.query<{n:number}>('SELECT count(*)::int AS n FROM '+q(name)+'.session WHERE id=$1',['deleted-session'])).rows[0].n,0);checks.push('credential_password_and_session_preserved_deleted_session_absent');
  assert.equal((await client.query<{value:string}>("SELECT payload->>'large' AS value FROM "+q(name)+'.external_tasks WHERE id=20')).rows[0].value,'9007199254740993');checks.push('json_integer_beyond_js_precision_preserved');
  const tuple=await saver.getTuple({configurable:{thread_id:thread,checkpoint_ns:'',checkpoint_id:checkpoint}});assert.equal(tuple?.checkpoint.channel_values.answer,cp.channel_values.answer);assert.deepEqual(Array.from(tuple.checkpoint.channel_values.binary as Uint8Array),Array.from(cp.channel_values.binary));assert.deepEqual(tuple?.metadata,metadata);assert.deepEqual(tuple?.pendingWrites,[['recovery-task','answer',{pending:'synthetic'}]]);checks.push('postgres_saver_reads_restored_checkpoint_binary_pending_write');
  for(const d of [768,1536]){const t=d===768?'scene_embeddings_768':'scene_embeddings';const r=await client.query<{user_id:string;video_id:string;score:number}>('SELECT user_id,video_id,1-(embedding <=> $1::vector) AS score FROM '+q(name)+'.'+q(t),[JSON.stringify(vectors.find(v=>v.values.length===d)!.values)]);assert.equal(r.rows.length,1);assert.equal(r.rows[0].user_id,owner);assert.equal(r.rows[0].video_id,'50');assert(Number(r.rows[0].score)>.999);}
  checks.push('both_vector_dimensions_pgvector_similarity_and_ownership');assert.equal(await legacy(),legacyBefore);checks.push('27_archived_legacy_sentinel_tables_unchanged');
  const repeat=await restore(second,vectors);assert.equal(repeat.sha256,(proof.recovery as {sha256:string}).sha256);checks.push('repeat_restore_has_same_fingerprint');
  const id=(await client.query<{id:string}>('INSERT INTO '+q(name)+'.videos(file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id) SELECT file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id FROM '+q(name)+'.videos WHERE id=50 RETURNING id')).rows[0].id;assert(Number(id)>50);checks.push('identity_sequence_next_insert_above_restored_max');
  proof.status='passed';proof.finishedAt=new Date().toISOString();
 }finally{
  await saver.end();if(created){await client.query('DROP SCHEMA '+q(chat)+' CASCADE');await client.query('DROP SCHEMA '+q(name)+' CASCADE');}await client.end();proof.localSchemasRemoved=true;await writeFile(resolve(args[3]),JSON.stringify(proof,null,2)+'\n',{mode:0o600});
 }
 console.info(JSON.stringify({status:proof.status,checks:(proof.checks as string[]).length,productionModified:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('Isolated postwrite rehearsal failed; inspect private evidence. Production is unchanged.');process.exitCode=1;}}
