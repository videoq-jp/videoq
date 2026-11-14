import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import type {D1PreparedStatement} from '@cloudflare/workers-types';
import {createD1Fixture} from './d1-fixture';
import {importSceneTables} from '../../scripts/migrations/d1/import-scenes';
describe('bounded atomic scene import groups',()=>{
 let fixture:Awaited<ReturnType<typeof createD1Fixture>>,directory:string,path:string;
 const rows=()=>Array.from({length:7},(_,i)=>({scene:{id:'scene-'+i,content:'Synthetic scene '+i,startTime:'00:01',endTime:'00:02',embedding:Array(1536).fill(.02)},videoId:1,userId:'owner',dimensions:1536,revision:'run',vectorId:'vector-'+i}));
 beforeEach(async()=>{
  fixture=await createD1Fixture();directory=await mkdtemp(join(tmpdir(),'scene-import-groups-'));path=join(directory,'scenes');
  await fixture.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','Owner','owner@example.test',0,0,0,0)").run();
  await fixture.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Video','','completed','','','2026-01-01','','uploaded','','')").run();
  await fixture.database.prepare("INSERT INTO migration_imports(id,archive_sha256,mapping_sha256,status) VALUES('common','archive','mapping','common_imported')").run();
  await writeFile(path,rows().map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600});
 });
 afterEach(async()=>{await fixture?.dispose();await rm(directory,{recursive:true,force:true});});
 const state=()=>fixture.database.prepare("SELECT row_index,imported_rows,status FROM migration_imports WHERE id='scenes'").first<{row_index:number;imported_rows:number;status:string}>();
 it('uses fewer provider round trips than scene rows while checking every value',async()=>{
  let calls=0;const db=new Proxy(fixture.database,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{calls++;return target.batch(statements);};const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await importSceneTables(db,{path,rows:'7'},'archive','mapping');expect(calls).toBeLessThan(7);
  expect(await state()).toMatchObject({row_index:7,imported_rows:7,status:'scenes_imported'});
  await fixture.database.prepare("UPDATE scenes SET content='changed' WHERE id='scene-6'").run();
  await expect(importSceneTables(fixture.database,{path,rows:'7'},'archive','mapping')).rejects.toThrow();
 });
 it('resumes after an entire committed group loses its response',async()=>{
  let lost=false;const db=new Proxy(fixture.database,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(!lost&&(await state())!.row_index>0){lost=true;throw new Error('synthetic lost response');}return result;};const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await expect(importSceneTables(db,{path,rows:'7'},'archive','mapping')).rejects.toThrow();
  const saved=await state();expect(saved!.row_index).toBeGreaterThan(1);expect(saved!.row_index).toBeLessThan(7);
  expect(await fixture.database.prepare('SELECT count(*) FROM scenes').first('count(*)')).toBe(saved!.row_index);
  await importSceneTables(fixture.database,{path,rows:'7'},'archive','mapping');expect(await state()).toMatchObject({imported_rows:7,status:'scenes_imported'});
  expect(await fixture.database.prepare('SELECT count(*) FROM scene_index_tasks').first('count(*)')).toBe(7);
 });
 it('rolls every scene and its progress back when a later row in the group conflicts',async()=>{
  const changed=rows();changed[3].userId='other';await writeFile(path,changed.map(row=>JSON.stringify(row)+'\n').join(''));
  await expect(importSceneTables(fixture.database,{path,rows:'7'},'archive','mapping')).rejects.toThrow();
  expect(await state()).toMatchObject({row_index:0,imported_rows:0});
  expect(await fixture.database.prepare('SELECT count(*) FROM scenes').first('count(*)')).toBe(0);
  expect(await fixture.database.prepare('SELECT count(*) FROM scene_index_tasks').first('count(*)')).toBe(0);
  await writeFile(path,rows().map(row=>JSON.stringify(row)+'\n').join(''));
  expect(await importSceneTables(fixture.database,{path,rows:'7'},'archive','mapping')).toMatchObject({scene_import_complete:true,scenes_imported:'7'});
 });
});
