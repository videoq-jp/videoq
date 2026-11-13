import {readFile} from 'node:fs/promises';
import {validateStagingTarget} from './migrations/d1/staging-target';
import {fileURLToPath} from 'node:url';
import {getPlatformProxy} from 'wrangler';
import type {D1Database,Vectorize} from '@cloudflare/workers-types';
import {createD1SceneIndexWriter} from '../src/persistence/d1/scene-index-writer';
import {synchronizeD1SceneIndex} from '../src/persistence/d1/scene-index-sync';
import {createD1SceneSearchRepository} from '../src/persistence/d1/scene-search';
type Env={DB:D1Database;SCENE_VECTORIZE_1536:Vectorize;SCENE_VECTORIZE_768:Vectorize};

async function cleanupSynthetic(env:Env){
 const db=env.DB,indexes={768:env.SCENE_VECTORIZE_768,1536:env.SCENE_VECTORIZE_1536};
 const tasks=(await db.prepare("SELECT vector_id,dimensions FROM scene_index_tasks WHERE user_id GLOB 'migration-smoke-*'").all<{vector_id:string;dimensions:768|1536}>()).results;
 for(const dimensions of [768,1536] as const){const ids=tasks.filter(row=>row.dimensions===dimensions).map(row=>row.vector_id);if(ids.length)await indexes[dimensions].deleteByIds(ids);}

 for(let attempt=0;attempt<90;attempt++){
  let remaining=0;for(const dimensions of [768,1536] as const){const ids=tasks.filter(row=>row.dimensions===dimensions).map(row=>row.vector_id);if(ids.length)remaining+=(await indexes[dimensions].getByIds(ids)).length;}
  if(!remaining){
 await db.batch([
  db.prepare("DELETE FROM scene_index_tasks WHERE user_id GLOB 'migration-smoke-*'"),
  db.prepare("DELETE FROM video_index_heads WHERE video_id IN(SELECT id FROM videos WHERE user_id GLOB 'migration-smoke-*')"),
  db.prepare("DELETE FROM scene_index_runs WHERE user_id GLOB 'migration-smoke-*'"),
  db.prepare("DELETE FROM videos WHERE user_id GLOB 'migration-smoke-*'"),
  db.prepare("DELETE FROM users WHERE id GLOB 'migration-smoke-*'"),
 ]);
   const residual=await db.prepare("SELECT (SELECT count(*) FROM users WHERE id GLOB 'migration-smoke-*')+(SELECT count(*) FROM scene_index_tasks WHERE user_id GLOB 'migration-smoke-*') AS rows").first<{rows:number}>();if(residual?.rows!==0)throw new Error('Synthetic D1 cleanup was not observed');
   process.stdout.write(JSON.stringify({synthetic_cleanup_verified:true})+'\n');return;}
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 throw new Error('Synthetic cleanup was not observed');
}

/** Synthetic-only remote verification, isolated from production bindings. */
let phase='connect';
async function main(){
 const configPath=fileURLToPath(new URL('../wrangler.d1-staging.jsonc',import.meta.url));
 validateStagingTarget(await readFile(configPath,'utf8'));
 const proxy=await getPlatformProxy<Env>({configPath,envFiles:[],persist:false,remoteBindings:true});
 const {DB:db,SCENE_VECTORIZE_1536:large,SCENE_VECTORIZE_768:small}=proxy.env,indexes={1536:large,768:small};
 const key=crypto.randomUUID(),owners=[`migration-smoke-a-${key}`,`migration-smoke-b-${key}`],videos:number[]=[],vectorIds=new Map<number,string[]>(),writer=createD1SceneIndexWriter(db),pause=()=>new Promise(resolve=>setTimeout(resolve,2000));
 if(process.argv.includes('--cleanup-only')){try{await cleanupSynthetic(proxy.env);}finally{await proxy.dispose();}return;}
 const started=Date.now();let failure:unknown;
 try{
  await cleanupSynthetic(proxy.env);
  for(const owner of owners){
   phase='seed_user';
   await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)").bind(owner,owner,owner+'@example.invalid').run();
   phase='seed_video';const video=await db.prepare("INSERT INTO videos(user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(?,'Synthetic migration probe','synthetic.mp4','completed','','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'','uploaded','','') RETURNING id").bind(owner).first<{id:number}>();if(!video)throw new Error('Video insert failed');videos.push(video.id);
   phase='read_source';const source=await writer.readSource(video.id,owner);if(!source)throw new Error('Source missing');
   for(const dimensions of [768,1536] as const){const runId=`smoke-${key}-${video.id}-${dimensions}`,embedding=Array.from({length:dimensions},(_,index)=>index===0?1:index===1?.123456789:0);
    phase='start_run';if(!await writer.start({runId,videoId:video.id,userId:owner,sourceRevision:source.sourceRevision,dimensions,expectedScenes:1}))throw new Error('Start failed');
    phase='stage_scenes';if(!await writer.stage(runId,owner,[{id:crypto.randomUUID(),content:'Synthetic migration evidence',startTime:'00:00:01,000',endTime:'00:00:02,000',embedding}]))throw new Error('Stage failed');
    phase='publish_scenes';if(!await writer.publish(runId,owner))throw new Error('Publish failed');
   }
  }
  for(const dimensions of [768,1536] as const){const rows=await db.prepare('SELECT vector_id FROM scenes WHERE video_id IN (?,?) AND dimensions=?').bind(...videos,dimensions).all<{vector_id:string}>();vectorIds.set(dimensions,rows.results.map(row=>row.vector_id));}
  phase='synchronize';const delivery=await synchronizeD1SceneIndex(db,indexes,10);if(delivery.completed!==4||delivery.failed)throw new Error('Synthetic vector delivery failed');
  phase='verify_remote';const verificationStarted=Date.now();let observed=0,queries=0,success=false;
  for(let attempt=0;attempt<90;attempt++){
   observed=0;queries=0;
   for(const dimensions of [768,1536] as const){
    const binding=indexes[dimensions],items=await binding.getByIds(vectorIds.get(dimensions)!);observed+=items.length;
    for(const item of items)if(item.values.length!==dimensions||Math.fround(item.values[0])!==1||Math.fround(item.values[1])!==Math.fround(.123456789))throw new Error('Remote vector precision mismatch');
    const search=createD1SceneSearchRepository(db,binding,dimensions),queryEmbedding=Array.from({length:dimensions},(_,index)=>index===0?1:index===1?.123456789:0);
    const hits=await search.search({userId:owners[0],videoIds:[videos[0]],queryEmbedding,limit:10});if(hits.length===1&&hits[0].content==='Synthetic migration evidence'&&hits[0].videoId===videos[0])queries++;
    if((await search.search({userId:owners[1],videoIds:[videos[0]],queryEmbedding,limit:10})).length)throw new Error('Remote scope verification failed');
   }
   process.stdout.write(JSON.stringify({synthetic_verification_attempt:attempt+1,vectors_observed:observed,owned_queries_passed:queries})+'\n');
   if(observed===4&&queries===2){success=true;break;}if(Date.now()-verificationStarted>180000)break;await pause();
  }
  if(!success)throw new Error('Remote vectors did not become queryable within the bounded probe');
  process.stdout.write(JSON.stringify({remote_synthetic_smoke_passed:true,dimensions:[768,1536],vectors_observed:observed,owned_queries_passed:queries,cross_owner_queries_denied:2,elapsed_ms:Date.now()-started,production_modified:false})+'\n');
 }catch(error){failure=error;}
  try{
   await cleanupSynthetic(proxy.env);

 }catch(error){process.stderr.write(JSON.stringify({synthetic_cleanup_failed:true})+'\n');if(!failure)failure=error;}
 finally{await proxy.dispose();}
 if(failure instanceof Error)throw failure;if(failure)throw new Error('Synthetic probe failed');
}
main().catch((error:unknown)=>{const message=error instanceof Error?error.message:'';const category=['require is not defined','fetch failed','Unauthorized','Authentication','ECONNRESET','not supported','NOT NULL constraint failed','FOREIGN KEY constraint failed','no such table','D1_ERROR','D1_TYPE_ERROR','Vectorize','Start failed','Stage failed','Publish failed','Synthetic vector delivery failed'].find(value=>message.includes(value))??'unclassified';process.stderr.write(JSON.stringify({remote_staging_smoke_failed:true,diagnostic:message.replace(/https?:\/\/\S+/g,'[URL]').replace(/(['"]).*?\1/g,'[quoted]').replace(/[A-Za-z0-9_-]{32,}/g,'[redacted]').slice(0,500),phase,error_name:error instanceof Error?error.name:'unknown',category})+'\n');process.exitCode=1;});
