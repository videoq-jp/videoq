import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {PostgresSaver} from '@langchain/langgraph-checkpoint-postgres';
import {emptyCheckpoint,ERROR,TASKS,type BaseCheckpointSaver} from '@langchain/langgraph-checkpoint';
import {StateGraph,StateSchema,MessagesValue,START,END,interrupt,Command} from '@langchain/langgraph';
import {HumanMessage,AIMessage} from '@langchain/core/messages';
import {z} from 'zod';
import * as schema from '../../src/db/schema';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
import {exportPostgresArchive} from '../../scripts/migrations/d1/export';
import {importCommonTables} from '../../scripts/migrations/d1/import-common';
import {D1CheckpointSaver} from '../../src/persistence/d1/checkpoint-saver';
import {isolatedPostgres} from './isolated-postgres';
import {createD1Fixture} from './d1-fixture';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
const snapshot=(name:string)=>{const base=new URL('../../'+name+'/',import.meta.url),journal=JSON.parse(readFileSync(new URL('meta/_journal.json',base),'utf8'));return JSON.parse(readFileSync(new URL('meta/'+String(journal.entries.at(-1).idx).padStart(4,'0')+'_snapshot.json',base),'utf8'));};
describe.skipIf(!url)('PostgreSQL checkpoint archives on D1',()=>{
 let source:Awaited<ReturnType<typeof isolatedPostgres>>,target:Awaited<ReturnType<typeof createD1Fixture>>,directory:string,path:string,sourceSchema:string,memory:string,manifest:ReturnType<typeof buildMigrationManifest>,saver:PostgresSaver;
 const thread='checkpoint-migration-thread',lease='00000000-0000-4000-8000-000000000099',config={configurable:{thread_id:thread}};
 const metadata={source:'loop' as const,step:0,parents:{}};
 beforeEach(async()=>{
  source=await isolatedPostgres(url!);target=await createD1Fixture();directory=await mkdtemp(join(tmpdir(),'videoq-checkpoint-import-'));path=join(directory,'source.videoq-export.ndjson');manifest=buildMigrationManifest(snapshot('drizzle'),snapshot('drizzle-d1'));
  const client=await source.pool.connect();try{
   sourceSchema=(await client.query('SELECT current_schema() AS name')).rows[0].name;memory=sourceSchema+'_memory';manifest.auxiliary_sources[0].schema=memory;
   await client.query('BEGIN; SELECT pg_advisory_xact_lock(1228,1536); CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public; COMMIT');await client.query(`SET search_path TO "${sourceSchema}",public`);await client.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema))).map(sql=>sql.replaceAll('"public".','')).join('\n'));
   await client.query("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes) VALUES('owner','Owner','owner@example.test',false,0,0,0,0)");
   await client.query("INSERT INTO chat_conversations(thread_id,conversation_id,owner_user_id,lease_id,leased_until,expires_at) VALUES($1,'00000000-0000-4000-8000-000000000001','owner',$2,'2099-01-01','2099-01-01')",[thread,lease]);
  }finally{client.release();}
  saver=new PostgresSaver(source.pool,undefined,{schema:memory});await saver.setup();
 });
 afterEach(async()=>{await target?.dispose();if(source){await source.pool.query(`DROP SCHEMA IF EXISTS "${memory}" CASCADE`);await source.dispose();}await rm(directory,{recursive:true,force:true});});
 const exportSource=async()=>{const client=await source.pool.connect();try{await exportPostgresArchive(client,manifest,path,{schema:sourceSchema});}finally{client.release();}};
 const migrate=async(database=target.database)=>{await exportSource();return importCommonTables(database,path,manifest,{offlineStaging:true,batchRows:2});};
 const targetSaver=()=>new D1CheckpointSaver(target.database,{threadId:thread,leaseId:lease});
 const graph=(storage:BaseCheckpointSaver)=>new StateGraph(new StateSchema({messages:MessagesValue,question:z.string()})).addNode('answer',state=>({messages:[new AIMessage(`seen:${state.messages.length}:${state.question}`)]})).addEdge(START,'answer').addEdge('answer',END).compile({checkpointer:storage});
 it('continues a real graph and forks an archived parent with typed messages',async()=>{
  const first=await graph(saver).invoke({question:'one',messages:[new HumanMessage('最初')]},config);expect(first.messages).toHaveLength(2);
  const parent=(await saver.getTuple(config))!.checkpoint.id;
  await graph(saver).invoke({question:'two',messages:[new HumanMessage('second')]},config);
  const expected=(await saver.getTuple(config))!;await source.pool.query('UPDATE chat_conversations SET committed_checkpoint_id=$1 WHERE thread_id=$2',[expected.checkpoint.id,thread]);
  const result=await migrate();expect(result).toMatchObject({common_import_complete:true,checkpoint_import_complete:true,pending_special_rows:'0',execution_complete:false});
  const actual=(await targetSaver().getTuple(config))!;expect(actual.checkpoint).toEqual(expected.checkpoint);expect(actual.metadata).toEqual(expected.metadata);expect(actual.pendingWrites).toEqual(expected.pendingWrites);
  expect(actual.checkpoint.channel_values.messages).toEqual(expected.checkpoint.channel_values.messages);
  const continued=await graph(targetSaver()).invoke({question:'three',messages:[new HumanMessage('third')]},config);expect(continued.messages).toHaveLength(6);
  const fork=await graph(targetSaver()).invoke({question:'branch',messages:[new HumanMessage('branch')]},{configurable:{thread_id:thread,checkpoint_id:parent}});expect(fork.messages).toHaveLength(4);expect(fork.messages.some(message=>message.content==='second')).toBe(false);
 });
 it('resumes an archived interrupt rather than rebuilding from chat logs',async()=>{
  const build=(storage:BaseCheckpointSaver)=>new StateGraph(new StateSchema({value:z.string().default('')})).addNode('pause',()=>({value:interrupt<string,string>('choose')})).addEdge(START,'pause').addEdge('pause',END).compile({checkpointer:storage});
  expect(await build(saver).invoke({value:''},config)).toHaveProperty('__interrupt__');await migrate();
  expect((await build(targetSaver()).invoke(new Command({resume:'chosen'}),config)).value).toBe('chosen');
 });
 it('keeps namespaces, legacy sends, special writes and binary channel values',async()=>{
  const cp={...emptyCheckpoint(),id:'parent',v:3,channel_values:{data:new Uint8Array([0,255,92]),messages:[new HumanMessage('typed')],map:new Map([['key',new Set(['value'])]])},channel_versions:{data:1,messages:1,map:1}};
  const parent=await saver.put(config,cp,metadata,cp.channel_versions);await saver.putWrites(parent,[[TASKS,{node:'work',args:'pending'}],[ERROR,'failure']],'task','path');
  const child={...emptyCheckpoint(),id:'child',v:3,channel_values:{data:new Uint8Array([1,2])},channel_versions:{data:2}};await saver.put(parent,child,{...metadata,step:1},child.channel_versions);
  const nested={...emptyCheckpoint(),id:'nested',channel_values:{nested:'isolated'},channel_versions:{nested:1}};await saver.put({configurable:{thread_id:thread,checkpoint_ns:'nested'}},nested,metadata,nested.channel_versions);
  const expected=await saver.getTuple({configurable:{thread_id:thread,checkpoint_id:'child'}});await migrate();
  expect((await targetSaver().getTuple({configurable:{thread_id:thread,checkpoint_id:'child'}}))!.checkpoint.channel_values).toEqual({...expected!.checkpoint.channel_values,data:Uint8Array.from(expected!.checkpoint.channel_values.data as Uint8Array)});
  const previous=(await targetSaver().getTuple({configurable:{thread_id:thread,checkpoint_id:'parent'}}))!;expect(previous.checkpoint.channel_values.data).toEqual(new Uint8Array([0,255,92]));expect(previous.checkpoint.channel_values.map).toEqual(new Map([['key',new Set(['value'])]]));expect(previous.pendingWrites).toEqual((await saver.getTuple({configurable:{thread_id:thread,checkpoint_id:'parent'}}))!.pendingWrites);
  expect((await targetSaver().getTuple({configurable:{thread_id:thread,checkpoint_ns:'nested'}}))!.checkpoint.channel_values.nested).toBe('isolated');
 });
 it('matches PostgreSQL numeric version lexemes and reports unused blobs explicitly',async()=>{
  const checkpoint={...emptyCheckpoint(),id:'numeric',channel_values:{value:'kept'},channel_versions:{value:1,empty:1}};await saver.put(config,checkpoint,metadata,checkpoint.channel_versions);
  await source.pool.query(`UPDATE "${memory}".checkpoints SET checkpoint=jsonb_set(checkpoint,'{channel_versions,value}','1.0'::jsonb)`);
  await source.pool.query(`UPDATE "${memory}".checkpoint_blobs SET version='1.0' WHERE channel='value'`);
  await source.pool.query(`INSERT INTO "${memory}".checkpoint_blobs(thread_id,channel,version,type,blob) VALUES($1,'unused','old','json',$2)`,[thread,Buffer.from(JSON.stringify('unused-private-canary'))]);
  expect((await saver.getTuple(config))!.checkpoint.channel_values).toEqual({value:'kept'});
  const result=await migrate();expect(result).toMatchObject({checkpoint_import_complete:true,checkpoint_migration:{unused_blobs:'1'},pending_special_rows:'0'});expect((await targetSaver().getTuple(config))!.checkpoint.channel_values).toEqual({value:'kept'});
 });
 it.each(['missing-blob','unknown-codec','missing-commit','orphan','oversized','unknown-schema','corrupt-write','orphan-write'] as const)('rejects %s checkpoint data before common target writes',async(kind)=>{
  const checkpoint={...emptyCheckpoint(),id:'checkpoint',channel_values:{value:kind==='oversized'?'x'.repeat(1_800_001):'private-checkpoint-canary'},channel_versions:{value:1}};await saver.put(config,checkpoint,metadata,checkpoint.channel_versions);
  if(kind==='missing-blob')await source.pool.query(`DELETE FROM "${memory}".checkpoint_blobs`);
  if(kind==='unknown-codec')await source.pool.query(`UPDATE "${memory}".checkpoint_blobs SET type='unknown-private-checkpoint-canary'`);
  if(kind==='missing-commit')await source.pool.query("UPDATE chat_conversations SET committed_checkpoint_id='missing'");
  if(kind==='orphan')await source.pool.query('DELETE FROM chat_conversations');
  if(kind==='unknown-schema')await source.pool.query(`INSERT INTO "${memory}".checkpoint_migrations VALUES(6)`);
  if(kind==='corrupt-write'||kind==='orphan-write'){
   await saver.putWrites({configurable:{thread_id:thread,checkpoint_ns:'',checkpoint_id:'checkpoint'}},[['value','write']],'task');
   if(kind==='corrupt-write')await source.pool.query(`UPDATE "${memory}".checkpoint_writes SET blob=$1`,[Buffer.from('private-checkpoint-canary')]);
   else await source.pool.query(`UPDATE "${memory}".checkpoint_writes SET thread_id='missing-thread'`);
  }

  let failure:unknown;try{await migrate();}catch(error){failure=error;}expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain('private-checkpoint-canary');expect((await target.database.prepare('SELECT count(*) AS count FROM users').first<{count:number}>())!.count).toBe(0);
 });
 it('retries an ambiguous checkpoint batch without changing saved bytes',async()=>{
  const checkpoint={...emptyCheckpoint(),id:'checkpoint',channel_values:{value:'retry'},channel_versions:{value:1}};await saver.put(config,checkpoint,metadata,checkpoint.channel_versions);await exportSource();
  let lost=false;const wrapped=new Proxy(target.database,{get(object,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await object.batch(statements);if(!lost&&(await object.prepare('SELECT count(*) AS count FROM conversation_checkpoints').first<{count:number}>())!.count>0){lost=true;throw new Error('lost reply');}return result;};const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
  await expect(importCommonTables(wrapped,path,manifest,{offlineStaging:true})).rejects.toThrow();expect(lost).toBe(true);expect(await importCommonTables(target.database,path,manifest,{offlineStaging:true})).toMatchObject({checkpoint_import_complete:true});expect((await targetSaver().getTuple(config))!.checkpoint.channel_values.value).toBe('retry');
 });
});
