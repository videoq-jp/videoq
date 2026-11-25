/** Disposable synthetic deployment ONLY. Never use this as production entrypoint. */
import { consumeBackgroundJobs } from '../../src/integrations/background-jobs/queue';
import { observeOperationalPolicy } from '../../src/integrations/operational-policy/observe';
import { processExternalTasks } from '../../src/lib/external-tasks';
import { createApp } from '../../src/app';
import { createD1Auth } from '../../src/persistence/d1/auth';
import { maintainSceneIndex } from '../../src/persistence/factory';
import { openSceneSearch } from '../../src/persistence/scene-search';
import { createD1VideoMutationRepository } from '../../src/persistence/d1/video-mutation-repository';
import { resolveEmbeddingConfig,embeddingFingerprint } from '../../src/lib/embedding-contract';
import { embedTexts } from '../../src/lib/embeddings';
import { streamRag } from '../../src/lib/rag';
import { traces,timed,measuredD1,type Trace } from './trace';
import type {VectorizeVector} from '@cloudflare/workers-types';
import type { Bindings } from '../../src/types/bindings';
export { RateLimiter } from '../../src/durable-objects/rate-limiter';
export { TaskScheduler } from '../../src/durable-objects/task-scheduler';
export { RecoveryWorkflow } from '../../test/persistence/search-recovery-fixture.worker';
const app=createApp();
const vectorHash=async(values:ArrayLike<number>)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Float32Array(Array.from(values)).buffer))).map(n=>n.toString(16).padStart(2,'0')).join('');
async function realProvenance(env:Bindings) {
 const object=await env.VIDEO_BUCKET!.get('acceptance-provenance/real-model.json');if(!object)return {passed:false,reason:'no-real-model-recomputation'};
 const saved=await object.json<{fingerprint:string;model:string;rows:{vectorId:string;hash:string}[]}>();
 const rows=(await env.DB!.prepare('SELECT s.vector_id,s.id,s.revision,s.video_id,v.user_id FROM scenes s JOIN videos v ON v.id=s.video_id WHERE s.dimensions=768').all<{vector_id:string;id:string;revision:string;video_id:number;user_id:string}>()).results;
 const vectors=rows.length?await env.SCENE_VECTORIZE_768!.getByIds(rows.map(row=>row.vector_id)):[];
 const checks=await Promise.all(rows.map(async row=>{
  const actual=vectors.find(vector=>vector.id===row.vector_id),expected=saved.rows.find(value=>value.vectorId===row.vector_id);
  const query=await env.SCENE_VECTORIZE_768!.queryById(row.vector_id,{topK:1,returnMetadata:'all',filter:{user_id:row.user_id,video_id:row.video_id,vector_id:row.vector_id}});
  const hit=query.matches[0];
  return {valueHashMatches:Boolean(actual&&expected&&await vectorHash(actual.values)===expected.hash),annMatches:hit?.id===row.vector_id&&hit.metadata?.revision===row.revision&&hit.metadata?.scene_id===row.id};
 }));
 return {passed:rows.length>0&&rows.length===saved.rows.length&&checks.every(row=>row.valueHashMatches&&row.annMatches)&&saved.fingerprint===await embeddingFingerprint(resolveEmbeddingConfig(env)),currentScenes:rows.length,verifiedScenes:checks.filter(row=>row.valueHashMatches&&row.annMatches).length,checks,model:saved.model,fingerprint:saved.fingerprint,syntheticEmbedding:false};
}
export default {queue:consumeBackgroundJobs,async fetch(request:Request,env:Bindings,context:ExecutionContext) {
 const path=new URL(request.url).pathname;
 if(!path.startsWith('/acceptance/')) return app.fetch(request,env,context);
 // Defense against accidental use with production resources, independent of request auth.
 if(env.BETTER_AUTH_URL!=='https://videoq-acceptance-20261125-c33d.yukiharada1228.workers.dev') return new Response(null,{status:403});
 const trace:Trace={stages:{},reads:0,writes:0,queries:0,phase:'authentication'};
 return traces.run(trace,async()=>{
  const start=performance.now(),database=measuredD1(env.DB!);
  const session=await timed('authentication',()=>createD1Auth({...env,DB:database},database,'browser').api.getSession({headers:request.headers,query:{disableCookieCache:true,disableRefresh:true}}));
  if(!session||session.user.role!=='admin') return new Response(null,{status:403});
  if(request.method!=='POST') return new Response(null,{status:405});
  if(path==='/acceptance/cleanup-objects') {
   let count=0;for(let i=0;i<20;i++){const page=await env.VIDEO_BUCKET!.list({limit:1000});if(!page.objects.length)return Response.json({deleted:count,remaining:0});await env.VIDEO_BUCKET!.delete(page.objects.map(row=>row.key));count+=page.objects.length;}return new Response(null,{status:409});
  }
  if(path==='/acceptance/reconcile') {
   const value=await env.VIDEO_BUCKET!.get('acceptance-backup/manifest.json');if(!value)return new Response(null,{status:409});
   const manifest=await value.json<{keys:string[];vectors:VectorizeVector[]}>();
   let objectsEqual=true;
   for(const key of manifest.keys) {const original=await env.VIDEO_BUCKET!.get(key),backup=await env.VIDEO_BUCKET!.get('acceptance-backup/'+key);if(!original||!backup){objectsEqual=false;continue;}const a=new Uint8Array(await original.arrayBuffer()),b=new Uint8Array(await backup.arrayBuffer());objectsEqual=objectsEqual&&a.length===b.length&&a.every((byte,i)=>byte===b[i]);}
   const actual=manifest.vectors.length?await env.SCENE_VECTORIZE_768!.getByIds(manifest.vectors.map(row=>row.id)):[];
   const vectorsEqual=actual.length===manifest.vectors.length&&manifest.vectors.every(saved=>{const restored=actual.find(row=>row.id===saved.id);return restored&&restored.values.length===768&&Array.from(saved.values).every((n,i)=>Math.fround(n)===Math.fround(restored.values[i]));});
   const loss=await env.DB!.prepare("SELECT count(*) AS n FROM external_tasks WHERE dedupe_key='synthetic-post-snapshot-loss'").first<number>('n');
   const corrupted=await env.DB!.prepare("SELECT count(*) AS n FROM scenes WHERE content='CORRUPTED SYNTHETIC DATA'").first<number>('n');
   return Response.json({objectsEqual,vectorsEqual,snapshotObjects:manifest.keys.length,snapshotVectors:manifest.vectors.length,postSnapshotMarkerLost:loss===0,corruptionReverted:corrupted===0});
  }
  if(path==='/acceptance/auth-check') {
   const own=await openSceneSearch(env,{userId:'owner',videoIds:[1,2]});
   const foreign=await openSceneSearch(env,{userId:'synthetic-non-owner',videoIds:[1,2]});
   try {const visible=await own.search('What is sampling?'),denied=await foreign.search('What is sampling?');
    return Response.json({ownerHits:visible.length,foreignHits:denied.length,onlyFixture:visible.every(row=>[1,2].includes(row.videoId)),authorizationPassed:visible.length>0&&denied.length===0});
   }finally{await own.close();await foreign.close();}
  }
  if(path==='/acceptance/delete-check') {
   const ids=(await env.DB!.prepare('SELECT vector_id FROM scenes WHERE video_id=2').all<{vector_id:string}>()).results.map(row=>row.vector_id);
   const vectors=ids.length?await env.SCENE_VECTORIZE_768!.getByIds(ids):[];
   const deleted=await createD1VideoMutationRepository(env.DB!).delete(2,'owner');
   // Preserve stale index entries deliberately: authoritative hydration must revoke access immediately.
   if(vectors.length)await env.SCENE_VECTORIZE_768!.upsert(vectors);
   const search=await openSceneSearch(env,{userId:'owner',videoIds:[2]});
   try {const hits=await search.search('What is sampling?');return Response.json({deleted:deleted.deleted,retainedStaleVectors:vectors.length,visibleAfterDelete:hits.length,deletionDenied:hits.length===0});}finally{await search.close();}
  }
  if(path==='/acceptance/real-provenance') return Response.json(await realProvenance(env));
  if(path==='/acceptance/reindex-real') {
   const rows=(await env.DB!.prepare('SELECT s.id,s.content,s.vector_id,s.revision,s.video_id,v.user_id FROM scenes s JOIN videos v ON s.video_id=v.id WHERE s.dimensions=768 LIMIT 50').all<{id:string;content:string;vector_id:string;revision:string;video_id:number;user_id:string}>()).results;
   const embeddings=await embedTexts(env,rows.map(row=>row.content),'document');
   if(rows.length) await env.SCENE_VECTORIZE_768!.upsert(rows.map((row,i)=>({id:row.vector_id,values:embeddings[i],metadata:{vector_id:row.vector_id,scene_id:row.id,revision:row.revision,user_id:row.user_id,video_id:row.video_id}})));
   const config=resolveEmbeddingConfig(env),fingerprint=await embeddingFingerprint(config);
   await env.VIDEO_BUCKET!.put('acceptance-provenance/real-model.json',JSON.stringify({model:config.model,fingerprint,rows:await Promise.all(rows.map(async(row,i)=>({vectorId:row.vector_id,hash:await vectorHash(embeddings[i])})))}));
   return Response.json({count:rows.length,model:config.model,fingerprint,dimensions:embeddings.map(value=>value.length),syntheticEmbedding:false});
  }
  if(path==='/acceptance/snapshot') {
   // Single fixture writer is this authenticated harness; no live ingestion exists.
   await env.VIDEO_BUCKET!.put('fixture-media','Synthetic fixture media, not a playable production video');
   await env.VIDEO_BUCKET!.put('fixture-media-v2','Synthetic second media fixture');
   const page=await env.VIDEO_BUCKET!.list({limit:100});if(page.truncated) return new Response(null,{status:409});
   const keys=page.objects.filter(object=>!object.key.startsWith('acceptance-backup/')).map(object=>object.key);
   for(const key of keys) {const value=await env.VIDEO_BUCKET!.get(key);if(!value) throw Error('Snapshot object missing');await env.VIDEO_BUCKET!.put('acceptance-backup/'+key,await value.arrayBuffer());}
   const scenes=(await env.DB!.prepare('SELECT vector_id FROM scenes WHERE dimensions=768').all<{vector_id:string}>()).results;
   const vectors=scenes.length?await env.SCENE_VECTORIZE_768!.getByIds(scenes.map(row=>row.vector_id)):[];
   await env.VIDEO_BUCKET!.put('acceptance-backup/manifest.json',JSON.stringify({keys,vectors:vectors.map(row=>({...row,values:Array.from(row.values)}))}));
   return Response.json({objects:keys.length,vectors:vectors.length,dimensions:vectors.map(value=>value.values.length)});
  }
  if(path==='/acceptance/disrupt') {
   const stored=await env.VIDEO_BUCKET!.get('acceptance-backup/manifest.json');if(!stored) return new Response(null,{status:409});
   const manifest=await stored.json<{keys:string[];vectors:{id:string}[]}>();
   await env.VIDEO_BUCKET!.delete(manifest.keys);
   if(manifest.vectors.length) await env.SCENE_VECTORIZE_768!.deleteByIds(manifest.vectors.map(value=>value.id));
   await env.DB!.prepare("UPDATE scenes SET content='CORRUPTED SYNTHETIC DATA' WHERE video_id=1").run();
   await env.DB!.prepare("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('sqs_job',?,'synthetic-post-snapshot-loss')").bind(JSON.stringify({message:{type:'reindex_video_transcript',job_id:'synthetic-post-snapshot-loss',payload:{video_id:1}}})).run();
   return Response.json({objectsDeleted:manifest.keys.length,vectorsDeleted:manifest.vectors.length,postSnapshotWrites:2});
  }
  if(path==='/acceptance/restore-artifacts') {
   const stored=await env.VIDEO_BUCKET!.get('acceptance-backup/manifest.json');if(!stored) return new Response(null,{status:409});
   const manifest=await stored.json<{keys:string[];vectors:VectorizeVector[]}>();
   for(const key of manifest.keys) {const value=await env.VIDEO_BUCKET!.get('acceptance-backup/'+key);if(!value) return new Response(null,{status:409});await env.VIDEO_BUCKET!.put(key,await value.arrayBuffer());}
   if(manifest.vectors.length) await env.SCENE_VECTORIZE_768!.upsert(manifest.vectors);
   return Response.json({objectsRestored:manifest.keys.length,vectorsRestored:manifest.vectors.length});
  }
  if(path==='/acceptance/maintain') return Response.json(await maintainSceneIndex(env));
  if(path==='/acceptance/policy-observe') {
   const delivery:{status?:number;transportFailed?:boolean}[]=[];
   const send:typeof fetch=async(input,init)=>{try{const response=await fetch(input,init);delivery.push({status:response.status});return response;}catch(error){await env.VIDEO_BUCKET!.put('acceptance-private/last-notification-error.json',JSON.stringify({name:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'unknown'}));delivery.push({transportFailed:true});throw Error('Fixture notification transport failed',{cause:error});}};
   try{return Response.json({observation:await observeOperationalPolicy(env,new Date(),send),delivery});}catch{return Response.json({failed:true,delivery},{status:502});}
  }
  if(path==='/acceptance/replay') {
   const job={type:'reindex_video_transcript',job_id:'isolated-recovery-v2',payload:{video_id:1}};
   await env.SEARCH_JOBS!.sendBatch([{body:job},{body:job}]);return Response.json({queuedDuplicates:2});
  }
  if(path==='/acceptance/outbox') return Response.json(await processExternalTasks(env,{limit:10,arm:false}));
  if(path==='/acceptance/state') {
   const page=await env.VIDEO_BUCKET!.list({limit:100});
   const objects=[];
   for(const object of page.objects) {
    const value=await env.VIDEO_BUCKET!.get(object.key);if(!value) throw Error('Fixture object disappeared');
    const bytes=await value.arrayBuffer(),sum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
    objects.push({keyHash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(object.key)))).map(b=>b.toString(16).padStart(2,'0')).join(''),contentHash:sum,size:object.size});
   }
   const rows=await env.DB!.prepare('SELECT vector_id FROM scenes WHERE dimensions=768 LIMIT 50').all<{vector_id:string}>();
   const vectors=rows.results.length?await env.SCENE_VECTORIZE_768!.getByIds(rows.results.map(row=>row.vector_id)):[];
   return Response.json({objects,vectorCount:vectors.length,vectorDimensions:vectors.map(v=>v.values.length)});
  }
  const provenance=await timed('provenance_validation',()=>realProvenance(env));if(!provenance.passed)return Response.json({failed:true,provenance},{status:409});
  const body=await request.json<{size:number}>();
  if(![1,100,1000].includes(body.size)) return new Response(null,{status:400});
  trace.phase='retrieval';
  const runEnv={...env,DB:database};
  const originalAI=env.AI!;
  runEnv.AI={run:(model:string,input:unknown,options:unknown)=>timed(model.includes('embedding')?'embedding_provider':'answer_provider',()=>originalAI.run(model,input as Record<string,unknown>,options as AiOptions))} as unknown as Ai;
  const originalIndex=env.SCENE_VECTORIZE_768!;
  runEnv.SCENE_VECTORIZE_768=new Proxy(originalIndex,{get(target,key){const value:unknown=Reflect.get(target,key);return key==='query'? (...args:Parameters<typeof target.query>)=>timed('vectorize',async()=>{try{return await target.query(...args);}catch(error){await env.VIDEO_BUCKET!.put('acceptance-private/last-vector-error.json',JSON.stringify({name:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'unknown'}));throw error;}}):typeof value==='function'?(value as (...values:unknown[])=>unknown).bind(target):value;}});
  try {
   let citations:number[]=[],text='';
   for await(const chunk of streamRag(runEnv,{messages:[{role:'user',content:'What is sampling according to the lesson? Answer in one sentence and cite the lesson.'}],ownerUserId:'owner',videoIds:Array.from({length:body.size},(_,i)=>i+1),locale:'en'})) {
    if('part' in chunk && trace.firstAnswerMs===undefined) trace.firstAnswerMs=performance.now()-start;
    if('final' in chunk) {const used=new Set(chunk.final.answer.segments.flatMap(segment=>segment.sourceIds));citations=chunk.final.answer.sources.filter(source=>used.has(source.id)).map(source=>source.video_id);text=chunk.final.answer.segments.map(segment=>segment.text).join('');}
   }
   trace.completeMs=performance.now()-start;
   return Response.json({trace,citations,quality:{hasText:text.trim().length>0,samplingConceptMentioned:/sampling|discrete|regular|continuous|measurements/i.test(text),onlyFixtureCitations:citations.length>0&&citations.every(id=>id===1)},fixture:'sampling-lesson-768',productionModified:false});
  }catch(error){await env.VIDEO_BUCKET!.put('acceptance-private/last-rag-error.json',JSON.stringify({name:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'unknown',cause:error instanceof Error&&error.cause instanceof Error?{name:error.cause.name,message:error.cause.message}:undefined}));return Response.json({trace,failed:true},{status:502});}
 });
}};
