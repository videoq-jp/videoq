import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedPostgres} from './isolated-postgres';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
import {exportPostgresArchive} from '../../scripts/migrations/d1/export';
import {openVerifiedPostgresSource} from '../../scripts/migrations/d1/verified-postgres-source';
import {importReadSnapshot,validateReadSnapshot} from '../../src/persistence/postgres/read-snapshot';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
const manifest=()=>{
 const columns={id:['integer','integer'],content:['text','text'],payload:['jsonb','text'],created:['timestamp with time zone','text']};
 const snapshot=(index:number)=>({dialect:index?'sqlite':'postgresql',tables:{probe:{name:'probe',columns:Object.fromEntries(Object.entries(columns).map(([name,types])=>[name,{name,type:types[index],notNull:true}]))}}});
 return buildMigrationManifest(snapshot(0),snapshot(1));
};

describe('PostgreSQL snapshot token validation',()=>{
 it('rejects arbitrary SQL and empty or oversized snapshot IDs before querying',async()=>{
  const calls:string[]=[],client={query:async(sql:string)=>{calls.push(sql);}};
  for(const token of ['',"00000001-00000001-1'; SELECT secret",'abc','1'.repeat(129)]){
   expect(()=>validateReadSnapshot(token)).toThrow();await expect(importReadSnapshot(client,token)).rejects.toThrow();
  }
  expect(calls).toEqual([]);
 });
});

describe.skipIf(!url)('verified PostgreSQL source snapshot',()=>{
 let fixture:Awaited<ReturnType<typeof isolatedPostgres>>,schema:string,directory:string,path:string;
 const handles:Awaited<ReturnType<typeof openVerifiedPostgresSource>>[]=[];
 beforeEach(async()=>{
  fixture=await isolatedPostgres(url!);schema=(await fixture.pool.query('SELECT current_schema() AS name')).rows[0].name;
  directory=await mkdtemp(join(tmpdir(),'videoq-source-proof-test-'));path=join(directory,'expected.videoq-export.ndjson');
  await fixture.pool.query("CREATE TABLE probe(id integer PRIMARY KEY,content text NOT NULL,payload jsonb NOT NULL,created timestamptz NOT NULL); INSERT INTO probe VALUES(1,'private-before-canary','{\"n\":9007199254740993,\"text\":\"字幕\"}','2026-11-13T01:02:03.456Z')");
 });
 afterEach(async()=>{
  await Promise.all(handles.splice(0).map(handle=>handle.dispose()));
  await fixture?.pool.query(`DROP SCHEMA IF EXISTS "${schema}_memory" CASCADE`);
  await fixture?.dispose();await rm(directory,{recursive:true,force:true});
 });
 const archive=async(plan=manifest())=>{
  const client=await fixture.pool.connect();try{await exportPostgresArchive(client,plan,path,{schema});}finally{client.release();}
 };
 const open=async(plan=manifest())=>{
  const handle=await openVerifiedPostgresSource({connectionString:url!,archivePath:path,manifest:plan,sourceSchema:schema});handles.push(handle);return handle;
 };
 it('verifies full rows/layouts without leaking records and pins subsequent reads to the checked snapshot',async()=>{
  await archive();const source=await open();
  expect(source.proof).toMatchObject({source_snapshot_equality_verified:true,source_tables_verified:1,source_rows_verified:'1',source_sequence_state_verified:false,source_catalog_constraints_verified:false});
  expect(JSON.stringify(source.proof)).not.toContain('private-before-canary');
  await fixture.pool.query("UPDATE probe SET content='private-after-canary'");
  const consumer=new pg.Client({connectionString:url!});await consumer.connect();
  try{
   await importReadSnapshot(consumer,source.snapshot);
   expect((await consumer.query(`SELECT content FROM "${schema}".probe`)).rows[0].content).toBe('private-before-canary');
   await expect(consumer.query(`UPDATE "${schema}".probe SET content='forbidden'`)).rejects.toMatchObject({code:'25006'});
   await consumer.query('ROLLBACK');
  }finally{await consumer.end();}
  await source.assertLive();
  await expect(open()).rejects.toThrow('differ');
  await source.dispose();await expect(source.assertLive()).rejects.toThrow('closed');
 });
 it('rejects same-count value drift, additional tables and layout-only drift',async()=>{
  await archive();
  await fixture.pool.query("UPDATE probe SET payload='{\"n\":9007199254740994}'");
  await expect(open()).rejects.toThrow('differ');
  await fixture.pool.query("UPDATE probe SET payload='{\"n\":9007199254740993,\"text\":\"字幕\"}'");
  await fixture.pool.query('ALTER TABLE probe DROP CONSTRAINT probe_pkey');
  await expect(open()).rejects.toThrow('differ');
  await fixture.pool.query('ALTER TABLE probe ADD PRIMARY KEY(id); CREATE TABLE extra_private_table(id integer)');
  await expect(open()).rejects.toThrow('verification failed');
 });
 it('includes auxiliary checkpoint layouts and binary values in equality checks',async()=>{
  const plan=manifest();plan.auxiliary_sources[0].schema=schema+'_memory';
  await fixture.pool.query(`CREATE SCHEMA "${schema}_memory"`);
  for(const table of plan.auxiliary_sources[0].tables){
   await fixture.pool.query(`CREATE TABLE "${schema}_memory"."${table}"(id integer PRIMARY KEY,blob bytea NOT NULL); INSERT INTO "${schema}_memory"."${table}" VALUES(1,decode('00ff2280','hex'))`);
  }
  await archive(plan);const source=await open(plan);
  expect(source.proof.source_tables_verified).toBe(5);
  await fixture.pool.query(`UPDATE "${schema}_memory".checkpoint_writes SET blob=decode('ff002280','hex')`);
  await expect(open(plan)).rejects.toThrow('differ');
 });
 it('rolls back a failed import and rejects expired snapshots rather than reading current values',async()=>{
  const coordinator=new pg.Client({connectionString:url!}),consumer=new pg.Client({connectionString:url!});
  await coordinator.connect();await consumer.connect();
  try{
   await coordinator.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const token=(await coordinator.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
   await coordinator.query('ROLLBACK');
   await expect(importReadSnapshot(consumer,token)).rejects.toThrow();
   expect((await consumer.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  }finally{await consumer.end();await coordinator.end();}
 });
});
