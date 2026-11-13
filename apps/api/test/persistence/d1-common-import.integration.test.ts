import {runStagingMigration} from '../../scripts/migrations/d1/staging-migration';
import {verifyArchiveSceneDelivery} from '../../scripts/migrations/d1/verify-scene-delivery';
import type {R2Bucket} from '@cloudflare/workers-types';
import {r2VisualMigrationStorage} from '../../scripts/migrations/d1/r2-visual-storage';
import type {Vectorize} from '@cloudflare/workers-types';
import {synchronizeD1SceneIndex} from '../../src/persistence/d1/scene-index-sync';
import {createD1SceneSearchRepository} from '../../src/persistence/d1/scene-search';
import {hashPassword} from 'better-auth/crypto';
import {drizzle} from 'drizzle-orm/node-postgres';
import {createAuth} from '../../src/lib/auth';
import {createD1Auth} from '../../src/persistence/d1/auth';
import type {Bindings} from '../../src/types/bindings';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../../src/db/schema';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
import {exportPostgresArchive} from '../../scripts/migrations/d1/export';
import {prepareCommonImport} from '../../scripts/migrations/d1/prepare-import';
import {importCommonTables} from '../../scripts/migrations/d1/import-common';
import {isolatedPostgres} from './isolated-postgres';
import {createD1Fixture} from './d1-fixture';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
const snapshot=(name:string)=>{const base=new URL('../../'+name+'/',import.meta.url),journal=JSON.parse(readFileSync(new URL('meta/_journal.json',base),'utf8'));return JSON.parse(readFileSync(new URL('meta/'+String(journal.entries.at(-1).idx).padStart(4,'0')+'_snapshot.json',base),'utf8'));};
describe.skipIf(!url)('offline common table imports',()=>{
 let source:Awaited<ReturnType<typeof isolatedPostgres>>,target:Awaited<ReturnType<typeof createD1Fixture>>,directory:string,path:string,sourceSchema:string,manifest:ReturnType<typeof buildMigrationManifest>;
 beforeEach(async()=>{
  source=await isolatedPostgres(url!);target=await createD1Fixture();directory=await mkdtemp(join(tmpdir(),'videoq-common-import-'));path=join(directory,'source.videoq-export.ndjson');manifest=buildMigrationManifest(snapshot('drizzle'),snapshot('drizzle-d1'));
  const client=await source.pool.connect();try{
   sourceSchema=(await client.query('SELECT current_schema() AS name')).rows[0].name;await client.query('BEGIN; SELECT pg_advisory_xact_lock(1228,1536); CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public; COMMIT');await client.query(`SET search_path TO "${sourceSchema}",public`);
   await client.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema))).map(sql=>sql.replaceAll('"public".','')).join('\n'));
   for(const user of ['alice','bob','owner'])await client.query("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes) VALUES($1,$3,$2,false,0,0,0,0)",[user,user+'@example.test',user]);
   await client.query("INSERT INTO session(id,user_id,token,expires_at) VALUES('s','alice','private-import-token','2099-01-01'); INSERT INTO account(id,account_id,user_id,provider_id,password) VALUES('a','alice','alice','credential','private-import-password')");
   await client.query("INSERT INTO videos(id,file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id) VALUES(1,'private-file','Video','','2026-01-01','','completed','','owner','uploaded','',''); INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(1,'owner','Course','','2026-01-01','2026-01-01',0); INSERT INTO video_course_members(course_id,video_id,added_at,\"order\") VALUES(1,1,'2026-01-01',0); INSERT INTO course_questions(id,course_id,video_id,source_video_id,author_id,title,body) VALUES('00000000-0000-4000-8000-000000000001',1,1,1,'alice','Question','字幕'); INSERT INTO course_question_replies(id,question_id,author_id,body) VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','bob','Reply')");
   await client.query("INSERT INTO scene_embeddings(langchain_id,content,embedding,user_id,video_id) VALUES('00000000-0000-4000-8000-000000000003','Scene',$1,'owner',1)",[JSON.stringify(Array(1536).fill(.01))]);
   await exportPostgresArchive(client,manifest,path,{schema:sourceSchema});
  }finally{client.release();}
 });
 afterEach(async()=>{await target?.dispose();await source?.dispose();await rm(directory,{recursive:true,force:true});});
 const run=(database=target.database)=>importCommonTables(database,path,manifest,{offlineStaging:true,batchRows:1});
 const rows=async(table:string)=>(await target.database.prepare('SELECT * FROM '+table).all<Record<string,unknown>>()).results;
 it('imports authentication rows in FK order and reconciles values on repeated runs',async()=>{
  expect(await run()).toMatchObject({common_import_complete:true,execution_complete:false,pending_sequence_restore:false,pending_special_rows:'0',scene_import_complete:true,pending_vectorize_rows:'1',vectorize_delivery_complete:false,tables:56});
  expect(await rows('users')).toHaveLength(3);expect((await rows('session'))[0]).toMatchObject({user_id:'alice',token:'private-import-token'});expect((await rows('account'))[0].password).toBe('private-import-password');expect((await rows('migration_imports'))[0]).toMatchObject({status:'common_imported',imported_rows:10});
  expect(await run()).toMatchObject({common_import_complete:true});expect(await rows('users')).toHaveLength(3);expect((await rows('course_questions'))[0].body).toBe('字幕');expect(await rows('course_question_replies')).toHaveLength(1);expect(await rows('scenes')).toHaveLength(1);
 });
 const reexport=async()=>{await rm(path);const client=await source.pool.connect();try{await exportPostgresArchive(client,manifest,path,{schema:sourceSchema});}finally{client.release();}};
 const insertVideo=()=>target.database.prepare("INSERT INTO videos(file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id) VALUES('new-file','New','','2026-01-01','','completed','','owner','uploaded','','') RETURNING id").first<{id:number}>();
 it('restores a deleted high ID without reusing it',async()=>{
  await source.pool.query("SELECT setval(pg_get_serial_sequence('videos','id'),5000,false); INSERT INTO videos(file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id) VALUES('deleted-high-file','Deleted','','2026-01-01','','completed','','owner','uploaded','',''); DELETE FROM videos WHERE id=5000");await reexport();
  expect(await run()).toMatchObject({pending_sequence_restore:false});expect((await insertVideo())?.id).toBe(5001);
 });
 it('honors is_called=false when the next ID was explicitly restarted',async()=>{
  await source.pool.query("SELECT setval(pg_get_serial_sequence('videos','id'),5000,false)");await reexport();await run();expect((await insertVideo())?.id).toBe(5000);
 });
 it('retains a higher pre-existing SQLite high-water mark without creating fake data rows',async()=>{
  await target.database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('videos',9000)").run();await run();expect((await rows('videos')).map(row=>row.id)).toEqual([1]);expect((await insertVideo())?.id).toBe(9001);
 });
 it('uses catalog ownership when a PostgreSQL sequence has been renamed',async()=>{
  await source.pool.query("ALTER SEQUENCE videos_id_seq RENAME TO custom_video_counter; SELECT setval(pg_get_serial_sequence('videos','id'),6000,true)");await reexport();await run();expect((await insertVideo())?.id).toBe(6001);
 });
 it('preserves the allocated high-water mark of a cached PostgreSQL sequence',async()=>{
  await source.pool.query("ALTER SEQUENCE videos_id_seq CACHE 32; SELECT setval(pg_get_serial_sequence('videos','id'),100,false); SELECT nextval(pg_get_serial_sequence('videos','id'))");await reexport();await run();expect((await insertVideo())?.id).toBe(132);
 });
 it.each(['duplicate','noninteger','numeric-text','unsafe'] as const)('rejects %s target sequence metadata before target row writes',async(kind)=>{
  if(kind==='duplicate')await target.database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('videos',1),('videos',2)").run();
  if(kind==='noninteger')await target.database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('videos','bad')").run();
  if(kind==='numeric-text')await target.database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('videos','100')").run();
  if(kind==='unsafe')await target.database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('videos',9007199254740991)").run();
  await expect(run()).rejects.toThrow();expect(await rows('users')).toEqual([]);expect(await rows('migration_imports')).toEqual([]);
 });
 it('rejects a target key that lost AUTOINCREMENT without creating application rows',async()=>{
  const original=(await target.database.prepare("SELECT sql FROM sqlite_master WHERE name='videos'").first<{sql:string}>())!.sql;
  await target.database.prepare('DROP TABLE videos').run();await target.database.prepare(original.replace(/\bAUTOINCREMENT\b/i,'')).run();
  await expect(run()).rejects.toThrow();expect(await rows('users')).toEqual([]);expect(await rows('migration_imports')).toEqual([]);
 });
 it.each(['unsafe','custom-increment','unowned'] as const)('rejects %s sequences before importing any target rows',async(kind)=>{
  if(kind==='unsafe')await source.pool.query("SELECT setval(pg_get_serial_sequence('videos','id'),9007199254740991,true)");
  if(kind==='custom-increment')await source.pool.query('ALTER SEQUENCE videos_id_seq INCREMENT BY 2');
  if(kind==='unowned')await source.pool.query('CREATE SEQUENCE unowned_sequence');
  await reexport();await expect(run()).rejects.toThrow();expect(await rows('users')).toEqual([]);expect(await rows('migration_imports')).toEqual([]);
 });
 it('retries an ambiguous committed restoration response monotonically',async()=>{
  await source.pool.query("SELECT setval(pg_get_serial_sequence('videos','id'),7000,true)");await reexport();
  let lost=false;const wrapped=new Proxy(target.database,{get(object,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await object.batch(statements);const counter=await target.database.prepare("SELECT CAST(seq AS TEXT) AS value FROM sqlite_sequence WHERE name='videos'").first<{value:string}>();if(!lost&&counter?.value==='7000'){lost=true;throw new Error('lost restore response');}return result;};const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
  await expect(run(wrapped)).rejects.toThrow();expect(lost).toBe(true);await run();expect((await insertVideo())?.id).toBe(7001);
 });
 it('preserves a real PostgreSQL Better Auth session and credential across import',async()=>{
  await source.pool.query("UPDATE users SET email_verified=true,password_reset_required=false WHERE id='alice'");await source.pool.query("UPDATE account SET password=$1 WHERE id='a'",[await hashPassword('Migration-contract-password-123')]);
  const settings={ENVIRONMENT:'test',BETTER_AUTH_URL:'https://migration.example.test',FRONTEND_URL:'https://migration.example.test',BETTER_AUTH_SECRET:'migration-contract-secret-012345678901234567890'};
  const auth=createAuth({...settings,DEPLOYMENT_EDITION:'onprem',DATABASE_POOL:source.pool} as Bindings,drizzle(source.pool,{schema}),'browser');
  const signedIn=await auth.api.signInEmail({body:{email:'alice@example.test',password:'Migration-contract-password-123'},asResponse:true});expect(signedIn.status).toBe(200);
  const headers=new Headers({cookie:signedIn.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')});
  const original=await auth.api.getSession({headers,query:{disableCookieCache:true}});expect(original?.user.id).toBe('alice');
  await rm(path);const client=await source.pool.connect();try{await exportPostgresArchive(client,manifest,path,{schema:sourceSchema});}finally{client.release();}
  await run();const migrated=createD1Auth({...settings,DEPLOYMENT_EDITION:'cloud',DB:target.database} as Bindings,target.database,'browser');
  expect((await migrated.api.getSession({headers,query:{disableCookieCache:true}}))?.session.id).toBe(original!.session.id);
  const login=await migrated.api.signInEmail({body:{email:'alice@example.test',password:'Migration-contract-password-123'},asResponse:true});expect(login.status).toBe(200);
 });
 it('resumes after an ambiguous committed batch response without duplicate rows',async()=>{
  let lost=false;const wrapped=new Proxy(target.database,{get(object,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await object.batch(statements);if(!lost&&(await rows('users')).length===1){lost=true;throw new Error('lost response');}return result;};const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
  await expect(run(wrapped)).rejects.toThrow();expect(lost).toBe(true);expect(await rows('users')).toHaveLength(1);expect(await run()).toMatchObject({common_import_complete:true});expect((await rows('migration_imports'))[0].imported_rows).toBe(10);
 });
 it('rolls a failed batch back and resumes from its last checkpoint',async()=>{
  await target.database.prepare("CREATE TRIGGER reject_bob BEFORE INSERT ON users WHEN NEW.id='bob' BEGIN SELECT RAISE(ABORT,'private-import-password'); END").run();
  let error:unknown;try{await run();}catch(caught){error=caught;}expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('private-import-password');expect(await rows('users')).toHaveLength(1);
  await target.database.prepare('DROP TRIGGER reject_bob').run();expect(await run()).toMatchObject({common_import_complete:true});expect(await rows('users')).toHaveLength(3);
 });
 it('refuses a nonempty target before recording import progress',async()=>{
  await target.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('unrelated','Unrelated','unrelated@example.test',0,0,0,0)").run();
  await expect(run()).rejects.toThrow();expect(await rows('users')).toHaveLength(1);expect(await rows('migration_imports')).toEqual([]);
 });
 it('rejects a different valid archive before modifying an existing import',async()=>{
  await run();await source.pool.query("UPDATE users SET username='changed-user' WHERE id='alice'");await rm(path);const client=await source.pool.connect();try{await exportPostgresArchive(client,manifest,path,{schema:sourceSchema});}finally{client.release();}
  await expect(run()).rejects.toThrow('different archive');expect((await rows('users')).find(row=>row.id==='alice')?.username).toBe('alice');
 });
 it('rejects altered target column definitions before importing any rows',async()=>{
  await target.database.prepare('ALTER TABLE account ADD COLUMN unexpected TEXT').run();await expect(run()).rejects.toThrow('column schema');expect(await rows('users')).toEqual([]);expect(await rows('migration_imports')).toEqual([]);
 });
 it('detects corruption before any target writes',async()=>{
  await writeFile(path,(await readFile(path,'utf8')).replace('private-import-token','damaged-import-token'));await expect(run()).rejects.toThrow();expect(await rows('users')).toEqual([]);expect(await rows('migration_imports')).toEqual([]);
 });
 it('imports the verified private copy even if the original path changes afterwards',async()=>{
  let changed=false;const wrapped=new Proxy(target.database,{get(object,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!changed){changed=true;await writeFile(path,'damaged-original');}return object.batch(statements);};const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
  expect(await run(wrapped)).toMatchObject({common_import_complete:true});expect((await rows('session'))[0].token).toBe('private-import-token');
 });
 it('fences overlapping importers and leaves one consistent checkpoint',async()=>{
  const results=await Promise.allSettled([run(),run()]);expect(results.some(result=>result.status==='fulfilled')).toBe(true);expect(await run()).toMatchObject({common_import_complete:true});expect((await rows('migration_imports'))[0].imported_rows).toBe(10);expect(await rows('users')).toHaveLength(3);
 });
 it('rechecks previously imported values instead of trusting a completed marker',async()=>{
  await run();await target.database.prepare("UPDATE account SET password='changed' WHERE id='a'").run();await expect(run()).rejects.toThrow();
 });
 it('prepares the exported pgvector values and timing metadata privately without claiming delivery',async()=>{
  await source.pool.query("UPDATE scene_embeddings SET langchain_metadata=$1",[JSON.stringify({video_id:1,user_id:'owner',start_time:'00:00:01,000',end_time:'00:00:02,000'})]);await reexport();
  const prepared=await prepareCommonImport(path,manifest);try{
   expect(prepared.scenes).toMatchObject({rows:'1',prepared:true,vectorize_delivery_complete:false});expect(prepared.pending_special_rows).toBe('1');
   const scene=JSON.parse(await readFile(prepared.scenes.path,'utf8'));expect(scene).toMatchObject({videoId:1,userId:'owner',dimensions:1536,scene:{content:'Scene',startTime:'00:00:01,000',endTime:'00:00:02,000'}});expect(scene.scene.embedding).toHaveLength(1536);
   expect(await rows('users')).toEqual([]);
  }finally{await prepared.dispose();}
 });
 it.each(['wrong-owner','missing-video','zero-vector'] as const)('rejects %s pgvector source before any target writes',async kind=>{
  if(kind==='wrong-owner')await source.pool.query("UPDATE scene_embeddings SET user_id='alice'");
  if(kind==='missing-video')await source.pool.query('UPDATE scene_embeddings SET video_id=999999');
  if(kind==='zero-vector')await source.pool.query('UPDATE scene_embeddings SET embedding=$1',[JSON.stringify(Array(1536).fill(0))]);
  await reexport();await expect(run()).rejects.toThrow();expect(await rows('users')).toEqual([]);expect(await rows('migration_imports')).toEqual([]);
 });

 it('imports both model spaces with durable tasks and independent publication heads',async()=>{
  await source.pool.query("INSERT INTO scene_embeddings_768(langchain_id,content,embedding,user_id,video_id) VALUES('00000000-0000-4000-8000-000000000003','Local scene',$1,'owner',1)",[JSON.stringify(Array(768).fill(.02))]);await reexport();
  expect(await run()).toMatchObject({scene_import_complete:true,scenes_imported:'2',pending_vectorize_rows:'2',vectorize_delivery_complete:false,pending_special_rows:'0'});
  expect((await rows('scenes')).map(row=>Number(row.dimensions)).sort((a,b)=>a-b)).toEqual([768,1536]);expect(await rows('video_index_versions')).toHaveLength(1);expect(await rows('video_index_heads')).toHaveLength(2);expect((await rows('scene_index_runs')).every(row=>row.status==='published'&&row.expected_scenes===1)).toBe(true);expect((await rows('scene_index_tasks')).every(row=>row.completed_at===null&&JSON.parse(String(row.embedding)).length===row.dimensions)).toBe(true);
  await run();expect(await rows('scene_index_tasks')).toHaveLength(2);
 });
 it('resumes after a committed scene batch loses its response without duplicating tasks',async()=>{
  let lost=false;const wrapped=new Proxy(target.database,{get(object,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await object.batch(statements);if(!lost&&(await rows('scenes')).length){lost=true;throw new Error('lost scene response');}return result;};const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
  await expect(run(wrapped)).rejects.toThrow();expect(lost).toBe(true);await run();expect(await rows('scenes')).toHaveLength(1);expect(await rows('scene_index_tasks')).toHaveLength(1);expect((await rows('migration_imports')).find(row=>row.id==='scenes')).toMatchObject({status:'scenes_imported',imported_rows:1,row_index:1});
 });
 it.each(['content','task','head'] as const)('reconciles %s after a completed scene import',async kind=>{
  await run();if(kind==='content')await target.database.prepare("UPDATE scenes SET content='changed'").run();if(kind==='task')await target.database.prepare("UPDATE scene_index_tasks SET embedding='[]'").run();if(kind==='head')await target.database.prepare("UPDATE video_index_heads SET run_id='changed'").run();await expect(run()).rejects.toThrow();
 });

 it('delivers migrated embeddings through LangChain and hydrates owned text from D1',async()=>{
  await run();type Vector={id:string;values:number[];metadata:Record<string,string|number>};const vectors=new Map<string,Vector>();
  const index={describe:()=>Promise.resolve({dimensions:1536}),getByIds:(ids:string[])=>Promise.resolve(ids.flatMap(id=>vectors.has(id)?[vectors.get(id)!]:[])),upsert:async(input:Vector[])=>{input.forEach(vector=>vectors.set(vector.id,vector));return {mutationId:'migration-fixture'};},deleteByIds:()=>Promise.resolve({mutationId:'delete-fixture'}),query:()=>Promise.resolve({matches:[...vectors.values()].map(vector=>({...vector,score:.9}))})} as unknown as Vectorize;
  expect(await synchronizeD1SceneIndex(target.database,{1536:index})).toMatchObject({claimed:1,completed:1,failed:0});expect([...vectors.values()][0].values).toEqual(Array(1536).fill(.01));
  const search=createD1SceneSearchRepository(target.database,index,1536);expect(await search.search({queryEmbedding:Array(1536).fill(.01),userId:'owner',videoIds:[1],limit:10})).toMatchObject([{content:'Scene',videoId:1,videoTitle:'Video'}]);expect(await search.search({queryEmbedding:Array(1536).fill(.01),userId:'alice',videoIds:[1],limit:10})).toEqual([]);
  expect((await rows('scene_index_tasks'))[0]).toMatchObject({embedding:null});expect(await verifyArchiveSceneDelivery(target.database,path,manifest,{1536:index},{offlineStaging:true})).toMatchObject({vectorize_delivery_complete:true,verified:'1',search_quality_verified:false,execution_complete:false});
 });

 it('retains legacy visual checkpoints while explicitly reporting pending object migration',async()=>{
  const visualRun='00000000-0000-4000-8000-000000000010';await source.pool.query("INSERT INTO video_visual_runs(video_id,run_id,file_key,duration_ms,chunk_count,status) VALUES(1,$1,'private-file',61000,2,'ready')",[visualRun]);await source.pool.query('INSERT INTO video_visual_chunks(run_id,chunk_index,frame_count) VALUES($1,0,1),($1,1,0)',[visualRun]);await reexport();
  const prepared=await prepareCommonImport(path,manifest);try{expect(prepared.visuals).toMatchObject({runs:'1',ready_runs:'1',completed_chunks:'2',visual_objects_migrated:false});expect(JSON.parse(await readFile(prepared.visuals.path,'utf8')).runId).toBe(visualRun);}finally{await prepared.dispose();}
  expect(await run()).toMatchObject({pending_visual_runs:'1',visual_objects_migrated:false,execution_complete:false});expect((await rows('video_visual_runs'))[0]).toMatchObject({run_id:visualRun,publication_version:null});expect((await rows('video_visual_chunks')).every(row=>row.object_version===null)).toBe(true);
 });
 it.each(['stale-file','missing-grid','empty-ready'] as const)('rejects %s legacy visual source before any D1 rows',async kind=>{
  const visualRun='00000000-0000-4000-8000-000000000010';await source.pool.query("INSERT INTO video_visual_runs(video_id,run_id,file_key,duration_ms,chunk_count,status) VALUES(1,$1,$2,1000,1,'ready')",[visualRun,kind==='stale-file'?'other-file':'private-file']);if(kind!=='missing-grid')await source.pool.query('INSERT INTO video_visual_chunks(run_id,chunk_index,frame_count) VALUES($1,0,$2)',[visualRun,kind==='empty-ready'?0:1]);await reexport();await expect(run()).rejects.toThrow();expect(await rows('users')).toEqual([]);expect(await rows('migration_imports')).toEqual([]);
 });

 it('connects real PostgreSQL visual export to D1 publication and R2 copy',async()=>{
  await target.dispose();target=await createD1Fixture({r2:true});const visualRun='00000000-0000-4000-8000-000000000010';await source.pool.query("INSERT INTO video_visual_runs(video_id,run_id,file_key,duration_ms,chunk_count,status) VALUES(1,$1,'private-file',1000,1,'ready')",[visualRun]);await source.pool.query('INSERT INTO video_visual_chunks(run_id,chunk_index,frame_count) VALUES($1,0,1)',[visualRun]);await reexport();
  const image=Buffer.from([255,216,255,224,0,255,217]),metadata=Buffer.from(JSON.stringify({version:1,video_id:1,duration_seconds:1,sampling_interval_seconds:1,frames:[[0,0,image.length]]})),header=Buffer.alloc(12);header.write('VQFOC001');header.writeUInt32LE(metadata.length,8);
  await target.bucket!.put(`media/private-file.visual-v2/${visualRun}/0.bin`,Buffer.concat([header,metadata,image]));await target.bucket!.put(`media/private-file.visual-v2/${visualRun}/0.json`,JSON.stringify([{timestamp_seconds:0,jpeg_base64:image.toString('base64'),offset:12+metadata.length,length:image.length}]));
  const storage=r2VisualMigrationStorage(target.bucket as unknown as R2Bucket);expect(await importCommonTables(target.database,path,manifest,{offlineStaging:true,visualStorage:{source:storage,destination:storage}})).toMatchObject({common_import_complete:true,scene_import_complete:true,visual_objects_migrated:true,pending_visual_runs:'0',execution_complete:false});expect((await rows('video_visual_runs'))[0].publication_version).toBeTruthy();expect((await rows('video_visual_chunks'))[0].object_version).toBeTruthy();
 });

 it('runs separate CLI-engine import, delivery and archive verification phases',async()=>{
  type Vector={id:string;values:number[];metadata:Record<string,string|number>};const vectors=new Map<string,Vector>();let connects=0,disposed=0;
  const index={describe:()=>Promise.resolve({dimensions:1536}),getByIds:(ids:string[])=>Promise.resolve(ids.flatMap(id=>vectors.has(id)?[vectors.get(id)!]:[])),upsert:(input:Vector[])=>{input.forEach(vector=>vectors.set(vector.id,vector));return Promise.resolve({mutationId:'fixture'});}} as unknown as Vectorize;
  const connect=async()=>{connects++;return {env:{DB:target.database,SCENE_VECTORIZE_768:index,SCENE_VECTORIZE_1536:index},dispose:async()=>{disposed++;}};};
  const options={input:path,maxTasks:100,allowPendingVisuals:false};
  expect(await runStagingMigration({...options,mode:'import'},manifest,connect)).toMatchObject({phase:'import',common_import_complete:true,execution_complete:false});expect(await runStagingMigration({...options,mode:'deliver'},manifest,connect)).toMatchObject({phase:'deliver',completed:1,pending_tasks:0,vectorize_delivery_complete:false});expect(await runStagingMigration({...options,mode:'verify'},manifest,connect)).toMatchObject({phase:'verify',vectorize_delivery_complete:true,verified:'1',execution_complete:false});expect(connects).toBe(3);expect(disposed).toBe(3);
 });
 it('validates the private archive before opening a remote connection',async()=>{
  await writeFile(path,'damaged-private-canary');let connects=0;await expect(runStagingMigration({mode:'import',input:path,maxTasks:100,allowPendingVisuals:false},manifest,async()=>{connects++;throw new Error('must not connect');})).rejects.toThrow();expect(connects).toBe(0);
 });

 it('rejects pending visuals before opening a remote connection unless explicitly permitted',async()=>{
  const visualRun='00000000-0000-4000-8000-000000000010';await source.pool.query("INSERT INTO video_visual_runs(video_id,run_id,file_key,duration_ms,chunk_count,status) VALUES(1,$1,'private-file',1000,1,'ready')",[visualRun]);await source.pool.query('INSERT INTO video_visual_chunks(run_id,chunk_index,frame_count) VALUES($1,0,1)',[visualRun]);await reexport();let connects=0,disposed=0;
  const connect=async()=>{connects++;return {env:{DB:target.database,SCENE_VECTORIZE_768:{} as Vectorize,SCENE_VECTORIZE_1536:{} as Vectorize},dispose:async()=>{disposed++;}};};
  const options={mode:'import' as const,input:path,maxTasks:100,allowPendingVisuals:false};await expect(runStagingMigration(options,manifest,connect)).rejects.toThrow('visual');expect(connects).toBe(0);
  expect(await runStagingMigration({...options,allowPendingVisuals:true},manifest,connect)).toMatchObject({phase:'import',pending_visual_runs:'1',visual_objects_migrated:false,execution_complete:false});expect(connects).toBe(1);expect(disposed).toBe(1);
 });

});
