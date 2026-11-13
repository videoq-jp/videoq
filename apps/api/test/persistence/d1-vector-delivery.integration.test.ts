import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import type {Vectorize,VectorizeVector} from '@cloudflare/workers-types';
import {createD1Fixture} from './d1-fixture';
import {importSceneTables} from '../../scripts/migrations/d1/import-scenes';
import {verifyMigratedSceneVectors} from '../../scripts/migrations/d1/verify-scene-delivery';
import {synchronizeD1SceneIndex} from '../../src/persistence/d1/scene-index-sync';
import {sceneVectorId} from '../../src/persistence/d1/scene-index-writer';
describe('offline migrated Vectorize delivery verification',()=>{
 let fixture:Awaited<ReturnType<typeof createD1Fixture>>,directory:string,path:string,indexes:{768:Vectorize;1536:Vectorize},vectors:Map<number,Map<string,VectorizeVector>>,hook:((items:VectorizeVector[])=>Promise<VectorizeVector[]>)|undefined;
 beforeEach(async()=>{
  fixture=await createD1Fixture();directory=await mkdtemp(join(tmpdir(),'vector-delivery-'));path=join(directory,'scenes');vectors=new Map([[768,new Map()],[1536,new Map()]]);hook=undefined;
  await fixture.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','Owner','owner@example.test',0,0,0,0)").run();await fixture.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Video','file.mp4','completed','','','2026-01-01','','uploaded','','')").run();await fixture.database.prepare("INSERT INTO migration_imports(id,archive_sha256,mapping_sha256,status) VALUES('common','archive','mapping','common_imported')").run();
  const rows=[];for(const dimensions of [768,1536] as const){const scene={id:'scene-'+dimensions,content:'字幕',startTime:'00:01',endTime:'00:02',evidenceType:'transcript' as const,embedding:Array.from({length:dimensions},(_,index)=>index===0?.123456789:.02)},revision='run-'+dimensions;rows.push({scene,videoId:1,userId:'owner',dimensions,revision,vectorId:await sceneVectorId(revision,scene)});}
  await writeFile(path,rows.map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600});await importSceneTables(fixture.database,{path,rows:'2'},'archive','mapping');
  const index=(dimension:number)=>({describe:()=>Promise.resolve({dimensions:dimension}),upsert:(items:VectorizeVector[])=>{for(const item of items)vectors.get(dimension)!.set(item.id,{...item,values:Float32Array.from(item.values)});return Promise.resolve({mutationId:'fixture'});},getByIds:async(ids:string[])=>{const items=ids.flatMap(id=>vectors.get(dimension)!.has(id)?[vectors.get(dimension)!.get(id)!]:[]);return hook?hook(items):items;},deleteByIds:()=>Promise.resolve({mutationId:'delete-fixture'})}) as unknown as Vectorize;
  indexes={768:index(768),1536:index(1536)};
 });
 afterEach(async()=>{await fixture?.dispose();await rm(directory,{recursive:true,force:true});});
 const verify=(bindings=indexes)=>verifyMigratedSceneVectors(fixture.database,{path,rows:'2'},'archive',bindings,{offlineStaging:true});
 const deliver=()=>synchronizeD1SceneIndex(fixture.database,indexes);
 it('checks original float32 values and ownership after LangChain delivery without claiming search quality',async()=>{expect(await deliver()).toMatchObject({completed:2});expect(await verify()).toMatchObject({vectorize_delivery_complete:true,verified:'2',checked:'2',missing:'0',mismatched:'0',pending_tasks:'0',dimensions:[768,1536],search_quality_verified:false,execution_complete:false});});
 it('distinguishes accepted writes from objects not yet visible by ID',async()=>{await deliver();hook=async()=>[];expect(await verify()).toMatchObject({vectorize_delivery_complete:false,missing:'2',verified:'0'});hook=undefined;expect((await verify()).vectorize_delivery_complete).toBe(true);});
 it('reports uncompleted D1 outbox delivery instead of treating present vectors as complete',async()=>{expect(await verify()).toMatchObject({vectorize_delivery_complete:false,missing:'2',pending_tasks:'2'});});
 it.each(['value','owner','video','scene','revision','vector-id','namespace','dimension'] as const)('rejects %s mismatches in returned vectors',async kind=>{
  await deliver();hook=async items=>items.map(item=>{const metadata={...item.metadata},values=Array.from(item.values);let namespace=item.namespace;if(kind==='value')values[0]+=.01;if(kind==='owner')metadata.user_id='other';if(kind==='video')metadata.video_id=999;if(kind==='scene')metadata.scene_id='other';if(kind==='revision')metadata.revision='other';if(kind==='vector-id')metadata.vector_id='other';if(kind==='namespace')namespace='other';if(kind==='dimension')values.pop();return {...item,metadata,values,namespace};});expect(await verify()).toMatchObject({vectorize_delivery_complete:false,mismatched:'2'});
 });
 it('rejects an absent profile binding rather than substituting another model space',async()=>{await deliver();await expect(verify({1536:indexes[1536]} as typeof indexes)).rejects.toThrow('binding');});
 it('rejects the wrong index dimensions',async()=>{await deliver();await expect(verify({768:indexes[1536],1536:indexes[1536]})).rejects.toThrow('dimensions');});
 it('rejects unexpected duplicate provider results',async()=>{await deliver();hook=async items=>[...items,...items];await expect(verify()).rejects.toThrow('duplicate');});
 it('rechecks D1 ownership after provider callbacks',async()=>{await deliver();await fixture.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('other','Other','other@example.test',0,0,0,0)").run();hook=async items=>{await fixture.database.prepare("UPDATE videos SET user_id='other' WHERE id=1").run();return items;};await expect(verify()).rejects.toThrow();});
 it('does not log provider diagnostics or vector content',async()=>{await deliver();hook=()=>Promise.reject(new Error('private-provider-canary'));const error=await verify().catch(error=>error);expect(String(error)).not.toContain('private-provider-canary');});
 it('checks earlier D1 rows again after later provider reads finish',async()=>{await deliver();let calls=0;hook=async items=>{if(++calls===2)await fixture.database.prepare("UPDATE scenes SET content='changed after first check' WHERE dimensions=768").run();return items;};await expect(verify()).rejects.toThrow('changed');});
 it('rejects import receipt changes while provider reads are in flight',async()=>{await deliver();hook=async items=>{await fixture.database.prepare("UPDATE migration_imports SET archive_sha256='other' WHERE id='scenes'").run();return items;};await expect(verify()).rejects.toThrow('inventory');});
 it('freezes the prepared input before provider callbacks',async()=>{await deliver();hook=async items=>{await writeFile(path,'damaged-original');return items;};expect(await verify()).toMatchObject({vectorize_delivery_complete:true,verified:'2'});});

});
