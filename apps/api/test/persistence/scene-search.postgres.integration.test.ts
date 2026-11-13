import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGEngine,PGVectorStore} from '@yukiharada1228/langchain-postgres';
import {isolatedPostgres} from './isolated-postgres';
import {createPostgresSceneSearchRepository} from '../../src/persistence/postgres/scene-search';
import {createD1Fixture} from './d1-fixture';
import {createD1SceneSearchRepository} from '../../src/persistence/d1/scene-search';
import {evaluatePairedSceneSearch} from '../../scripts/migrations/d1/search-evaluation';
import type {Vectorize} from '@cloudflare/workers-types';
const databaseUrl=process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip).each([768,1536] as const)('PostgreSQL precomputed scene search (%i)',dimensions=>{
 let fixture:Awaited<ReturnType<typeof isolatedPostgres>>,repository:ReturnType<typeof createPostgresSceneSearchRepository>;
 const embedding=Array.from({length:dimensions},(_,i)=>i===0?1:0);
 beforeAll(async()=>{
  fixture=await isolatedPostgres(databaseUrl!,{includePublic:true});
  await fixture.pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await fixture.pool.query(`CREATE TABLE scene_vectors(langchain_id uuid PRIMARY KEY, content text NOT NULL,embedding public.vector(${dimensions}) NOT NULL,user_id text NOT NULL,video_id integer NOT NULL,langchain_metadata jsonb)`);
  for(const [id,user,video,content] of [[1,'owner',1,'owned selected'],[2,'owner',2,'owned unselected'],[3,'other',3,'other owner']] as const){
   await fixture.pool.query('INSERT INTO scene_vectors VALUES($1,$2,$3,$4,$5,$6)',[`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`,content,JSON.stringify(embedding),user,video,{video_title:'Synthetic',start_time:'00:01',end_time:'00:02'}]);
  }
  const schema=(await fixture.pool.query('SELECT current_schema() AS name')).rows[0].name;
  const store=await PGVectorStore.initialize(PGEngine.fromPool(fixture.pool),{embedQuery:async()=>{throw new Error('Evaluation must not regenerate embeddings');},embedDocuments:async()=>{throw new Error('Search must not write embeddings');}},'scene_vectors',{schemaName:schema,metadataColumns:['user_id','video_id']});
  repository=createPostgresSceneSearchRepository(store,dimensions);
 });
 afterAll(async()=>{await fixture?.dispose();});
 it('normalizes metadata and filters owner/selection through the actual pgvector store',async()=>{
  expect(await repository.search({queryEmbedding:embedding,userId:'owner',videoIds:[1,1,3],limit:1})).toEqual([{content:'owned selected',videoId:1,videoTitle:'Synthetic',startTime:'00:01',endTime:'00:02'}]);
  expect(await repository.search({queryEmbedding:embedding,userId:'other',videoIds:[1],limit:20})).toEqual([]);
  expect(await repository.search({queryEmbedding:embedding,userId:'owner',videoIds:[],limit:20})).toEqual([]);
 });
 it('rejects invalid vectors, limits and video IDs before store execution',async()=>{
  for(const override of [{queryEmbedding:[1]},{limit:51},{videoIds:[-1]},{queryEmbedding:embedding.map(()=>0)}]){
   await expect(repository.search({queryEmbedding:embedding,userId:'owner',videoIds:[1],limit:20,...override})).rejects.toThrow();
  }
 });
 it('evaluates actual PG/D1 persistence with identical embeddings (Vectorize results simulated)',async()=>{
  const target=await createD1Fixture();
  try{
   await target.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.invalid',0,0,0,0),('other','other','other@example.invalid',0,0,0,0)").run();
   await target.database.prepare("INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Synthetic','','','2026-01-01','','completed','','uploaded','','')").run();
   await target.database.prepare("INSERT INTO scenes(id,video_id,content,start_time,end_time,dimensions,revision) VALUES('synthetic-scene',1,'owned selected','00:01','00:02',?,'r1')").bind(dimensions).run();
   const index={query:async()=>({matches:[{id:'synthetic-scene',score:1,metadata:{scene_id:'synthetic-scene',revision:'r1'}}]})} as unknown as Vectorize;
   const d1=createD1SceneSearchRepository(target.database,index,dimensions);
   const report=await evaluatePairedSceneSearch({postgres:repository,d1},{version:1,cohort:'synthetic',corpusSha256:'a'.repeat(64),model:'synthetic-model',dimensions,samples:1,
    cases:['owner','other'].map(userId=>({queryEmbedding:embedding,userId,videoIds:[1],limit:20}))});
   expect(report.agreement).toMatchObject({reference_nonempty_pairs:1,both_empty_pairs:1,mean_reference_top_k_overlap:1,exact_rank_order_pairs:2});
   expect(report.execution_complete).toBe(false);
  }finally{await target.dispose();}
 });
});
