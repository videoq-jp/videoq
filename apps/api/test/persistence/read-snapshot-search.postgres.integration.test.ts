import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {openPostgresEmbeddingSceneSearch} from '../../src/persistence/postgres/scene-search';
import type {Bindings} from '../../src/types/bindings';
const databaseUrl=process.env.PERSISTENCE_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('request-scoped PostgreSQL search snapshots',()=>{
 it('keeps the verified view past pool idle timeout and refuses replacement connections',async()=>{
  const admin=new pg.Client({connectionString:databaseUrl}),name='snapshot_search_'+crypto.randomUUID().replaceAll('-','');
  await admin.connect();
  const url=new URL(databaseUrl!);url.pathname='/'+name;
  let writer:pg.Client|undefined,coordinator:pg.Client|undefined,search:Awaited<ReturnType<typeof openPostgresEmbeddingSceneSearch>>|undefined,created=false;
  try{
   await admin.query(`CREATE DATABASE "${name}"`);created=true;
   writer=new pg.Client({connectionString:url.toString()});await writer.connect();
   await writer.query('CREATE EXTENSION vector; CREATE TABLE scene_embeddings(langchain_id uuid PRIMARY KEY,content text NOT NULL,embedding vector(1536) NOT NULL,user_id text,video_id integer,langchain_metadata jsonb)');
   const embedding=Array.from({length:1536},(_,i)=>i===0?1:0);
   await writer.query("INSERT INTO scene_embeddings VALUES('00000000-0000-4000-8000-000000000001','before',$1,'owner',1,'{}')",[JSON.stringify(embedding)]);
   coordinator=new pg.Client({connectionString:url.toString()});await coordinator.connect();
   await coordinator.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const snapshot=(await coordinator.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
   url.searchParams.set('application_name','videoq-snapshot-search-fixture');
   search=await openPostgresEmbeddingSceneSearch({DATABASE_URL:url.toString()} as Bindings,undefined,undefined,{snapshot});
   await writer.query("UPDATE scene_embeddings SET content='after'");
   const request={queryEmbedding:embedding,userId:'owner',videoIds:[1],limit:20};
   expect((await search.search(request))[0].content).toBe('before');
   // node-postgres normally evicts released pool clients after ten idle seconds.
   await delay(11000);
   expect((await search.search(request))[0].content).toBe('before');
   const pid=(await writer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='videoq-snapshot-search-fixture'")).rows[0].pid;
   await writer.query('SELECT pg_terminate_backend($1)',[pid]);
   await delay(30);
   await expect(search.search(request)).rejects.toThrow('snapshot is unavailable');
   expect((await writer.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='videoq-snapshot-search-fixture'")).rows[0].count).toBe(0);
  }finally{
   await search?.close();await coordinator?.query('ROLLBACK').catch(()=>undefined);await coordinator?.end();await writer?.end();
   if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();
  }
 },30000);
});
