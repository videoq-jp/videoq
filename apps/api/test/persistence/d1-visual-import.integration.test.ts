import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import type {R2Bucket} from '@cloudflare/workers-types';
import {createD1Fixture} from './d1-fixture';
import {importVisualObjects} from '../../scripts/migrations/d1/import-visuals';
import {r2VisualMigrationStorage} from '../../scripts/migrations/d1/r2-visual-storage';
import {readFocusFrames} from '../../src/lib/focus-frames';
import {createD1VideoEvidenceRepository} from '../../src/persistence/d1/video-evidence-repository';
import type {VisualMigrationPlan} from '../../scripts/migrations/d1/prepare-visuals';
import type {Bindings} from '../../src/types/bindings';
const runId='00000000-0000-4000-8000-000000000003',image=Buffer.from([255,216,255,224,0,255,217]);
const plan:VisualMigrationPlan={videoId:1,runId,fileKey:'file.mp4',durationMs:1000,chunkCount:1,status:'ready',chunks:[{index:0,frameCount:1}]};
describe('offline visual migration on workerd D1 and R2',()=>{
 let fixture:Awaited<ReturnType<typeof createD1Fixture>>,directory:string,path:string,storage:ReturnType<typeof r2VisualMigrationStorage>;
 beforeEach(async()=>{
  fixture=await createD1Fixture({r2:true});directory=await mkdtemp(join(tmpdir(),'visual-import-'));path=join(directory,'plans');await writeFile(path,JSON.stringify(plan)+'\n',{mode:0o600});storage=r2VisualMigrationStorage(fixture.bucket as unknown as R2Bucket);
  await fixture.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','Owner','owner@example.test',0,0,0,0)").run();
  await fixture.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Video','file.mp4','completed','','','2026-01-01','','uploaded','','')").run();
  await fixture.database.prepare("INSERT INTO video_visual_runs(video_id,run_id,file_key,duration_ms,chunk_count,status) VALUES(1,?,'file.mp4',1000,1,'ready')").bind(runId).run();await fixture.database.prepare('INSERT INTO video_visual_chunks(run_id,chunk_index,frame_count) VALUES(?,0,1)').bind(runId).run();
  await fixture.database.prepare("INSERT INTO migration_imports(id,archive_sha256,mapping_sha256,status) VALUES('common','archive','mapping','common_imported')").run();
  const metadata=Buffer.from(JSON.stringify({version:1,video_id:1,duration_seconds:1,sampling_interval_seconds:1,frames:[[0,0,image.length]]})),header=Buffer.alloc(12);header.write('VQFOC001');header.writeUInt32LE(metadata.length,8);
  await fixture.bucket!.put(`media/file.mp4.visual-v2/${runId}/0.bin`,Buffer.concat([header,metadata,image]));await fixture.bucket!.put(`media/file.mp4.visual-v2/${runId}/0.json`,JSON.stringify([{timestamp_seconds:0,jpeg_base64:image.toString('base64'),offset:12+metadata.length,length:image.length}]));
 });
 afterEach(async()=>{await fixture?.dispose();await rm(directory,{recursive:true,force:true});});
 const plans=()=>({path,runs:'1',ready_runs:'1',completed_chunks:'1',visual_objects_migrated:false});
 const migrate=(destination=storage,database=fixture.database)=>importVisualObjects(database,plans(),'archive',directory,{source:storage,destination,offlineStaging:true});
 const resetStaging=async()=>{await rm(directory,{recursive:true,force:true});directory=await mkdtemp(join(tmpdir(),'visual-import-'));path=join(directory,'plans');await writeFile(path,JSON.stringify(plan)+'\n',{mode:0o600});};
 it('copies legacy objects, publishes D1 references and reads dense frames with the existing runtime',async()=>{
  expect(await migrate()).toMatchObject({visual_objects_migrated:true,visual_object_copy_complete:true,pending_visual_runs:'0',execution_complete:false});
  const evidence=await createD1VideoEvidenceRepository(fixture.database).getEvidence({ownerUserId:'owner',videoIds:[1]},1);expect(evidence?.visualManifestVersion).toBeTruthy();
  const frames=await readFocusFrames({VIDEO_BUCKET:fixture.bucket,USE_S3_STORAGE:'false'} as unknown as Bindings,{id:1,fileKey:'file.mp4',visualRunId:runId,visualManifestVersion:evidence!.visualManifestVersion},0,1,new AbortController().signal);
  expect(frames).toMatchObject({frames:[{timestamp_seconds:0,jpeg_base64:image.toString('base64')}]});
  expect((await fixture.database.prepare('SELECT status FROM visual_object_attempts').all()).results).toEqual([{status:'published'},{status:'published'}]);
  await resetStaging();expect(await migrate()).toMatchObject({copied:'0',retained:'4',visual_objects_migrated:true});
 });
 it('uses an atomic R2 create-only condition',async()=>{await storage.create('immutable',Buffer.from('first'));await expect(storage.create('immutable',Buffer.from('other'))).rejects.toThrow('already exists');expect(Buffer.from((await storage.read('immutable',10))!).toString()).toBe('first');});
 it('bounds R2 bodies before materializing them',async()=>{await fixture.bucket!.put('media/large','12345');await expect(storage.read('large',4)).rejects.toThrow('budget');});
 it('records cleanup ownership before a failed object PUT and resumes without publishing incomplete refs',async()=>{
  let fail=true;const destination={read:storage.read,create:async(key:string,bytes:Uint8Array)=>{await storage.create(key,bytes);if(fail){fail=false;throw new Error('private-provider-canary');}}};
  const error=await migrate(destination).catch(error=>error);expect(String(error)).not.toContain('private-provider-canary');expect(await fixture.database.prepare('SELECT publication_version FROM video_visual_runs').first('publication_version')).toBeNull();expect((await fixture.database.prepare('SELECT status FROM visual_object_attempts').all()).results.every(row=>row.status==='pending')).toBe(true);
  await resetStaging();expect(await migrate()).toMatchObject({retained:'1',visual_objects_migrated:true});
 });
 it('resumes after a committed chunk reference batch loses its response',async()=>{
  let lost=false;const database=new Proxy(fixture.database,{get(object,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await object.batch(statements);if(!lost&&await object.prepare('SELECT object_version FROM video_visual_chunks').first('object_version')){lost=true;throw new Error('lost commit');}return result;};const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
  await expect(migrate(storage,database)).rejects.toThrow();expect(lost).toBe(true);await resetStaging();expect(await migrate()).toMatchObject({visual_objects_migrated:true});
 });
 it('rejects altered publication references on completed retry',async()=>{await migrate();await fixture.database.prepare("UPDATE video_visual_runs SET publication_version='changed'").run();await resetStaging();await expect(migrate()).rejects.toThrow();});
 it('fences a source video changed while external copies were in flight',async()=>{
  let changed=false;const destination={read:storage.read,create:async(key:string,bytes:Uint8Array)=>{await storage.create(key,bytes);if(!changed){changed=true;await fixture.database.prepare("UPDATE videos SET file='other-file.mp4' WHERE id=1").run();}}};await expect(migrate(destination)).rejects.toThrow();expect(await fixture.database.prepare('SELECT publication_version FROM video_visual_runs').first('publication_version')).toBeNull();expect(await fixture.database.prepare('SELECT object_version FROM video_visual_chunks').first('object_version')).toBeNull();
 });

});
