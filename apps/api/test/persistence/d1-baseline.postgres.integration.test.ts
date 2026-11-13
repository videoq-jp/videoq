import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,stat,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {collectPostgresBaseline} from '../../scripts/migrations/d1/baseline';
import {isolatedPostgres} from './isolated-postgres';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
describe.skipIf(!url)('read-only D1 migration baseline',()=>{
 let fixture:Awaited<ReturnType<typeof isolatedPostgres>>,schema:string;
 beforeEach(async()=>{
  fixture=await isolatedPostgres(url!);schema=(await fixture.pool.query('SELECT current_schema() AS name')).rows[0].name;
  await fixture.pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await fixture.pool.query(`CREATE TABLE auth_data(id bigint PRIMARY KEY,secret text,payload jsonb); CREATE TABLE fixed_vectors(id bigint,embedding public.vector(768)); CREATE TABLE variable_vectors(embedding public.vector);`);
  await fixture.pool.query("INSERT INTO auth_data VALUES(1,'private-row-canary','{\"token\":\"private-json-canary\"}'),(9007199254740992,'private-password-canary','{}')");
  await fixture.pool.query('INSERT INTO fixed_vectors VALUES(1,$1)',[JSON.stringify(Array(768).fill(.01))]);
  for(const dimensions of [768,1536])await fixture.pool.query('INSERT INTO variable_vectors VALUES($1)',[JSON.stringify(Array(dimensions).fill(.02))]);
  await fixture.pool.query('INSERT INTO variable_vectors VALUES(NULL)');
 });
 afterEach(async()=>{await fixture?.dispose();});
 it('reports exact counts, safe integer hazards and actual dimensions without row contents',async()=>{
  const client=await fixture.pool.connect();try{
   const report=await collectPostgresBaseline(client,{schema,samples:3});
   expect(report.tables.map(t=>[t.name,t.rows])).toEqual([['auth_data','2'],['fixed_vectors','1'],['variable_vectors','3']]);
   expect(report.bigint_ranges.find(range=>range.table==='auth_data')).toMatchObject({min:'1',max:'9007199254740992',unsafe_rows:'1'});
   expect(report.vectors).toEqual([{table:'fixed_vectors',column:'embedding',declared_type:'public.vector(768)',dimensions:[{dimensions:768,rows:'1'}]},{table:'variable_vectors',column:'embedding',declared_type:'public.vector',dimensions:[{dimensions:null,rows:'1'},{dimensions:768,rows:'1'},{dimensions:1536,rows:'1'}]}]);
   expect(report.transaction).toEqual({isolation:'repeatable read',read_only:true});
   expect(report.conversion_findings).toEqual([{table:'auth_data',column:'id',issue:'bigint_outside_javascript_safe_integer_range'}]);
   expect(report.warm_round_trip_ms).toMatchObject({samples:3,p50:expect.any(Number),p95:expect.any(Number),p99:expect.any(Number)});
   expect(BigInt(report.database_bytes)).toBeGreaterThan(0n);expect(JSON.stringify(report)).not.toMatch(/private-.*canary/);
   expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('off');
  }finally{client.release();}
 });
 it('flags existing embedding dimensions unsupported by the configured cloud architecture',async()=>{
  await fixture.pool.query('INSERT INTO variable_vectors VALUES($1)',[JSON.stringify(Array(1024).fill(.03))]);
  const client=await fixture.pool.connect();try{const report=await collectPostgresBaseline(client,{schema,samples:1});expect(report.conversion_findings).toContainEqual({table:'variable_vectors',column:'embedding',issue:'vector_dimension_without_current_cloud_index',dimensions:1024});}finally{client.release();}
 });
 it('keeps a snapshot when another writer commits during collection',async()=>{
  const client=await fixture.pool.connect();let injected=false;
  try{
   const wrapped=new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{const result:unknown=await Reflect.apply(target.query,target,args);if(typeof args[0]==='string'&&args[0].startsWith('SELECT c.relname AS name')&&!injected){injected=true;await fixture.pool.query("INSERT INTO auth_data VALUES(3,'new-secret','{}')");}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
   const report=await collectPostgresBaseline(wrapped,{schema,samples:1});expect(injected).toBe(true);expect(report.tables.find(t=>t.name==='auth_data')?.rows).toBe('2');expect((await fixture.pool.query('SELECT count(*) FROM auth_data')).rows[0].count).toBe('3');
  }finally{client.release();}
 });
 it('rolls back failed collections and rejects invalid probe bounds',async()=>{
  const client=await fixture.pool.connect();try{
   await expect(collectPostgresBaseline(client,{schema:'missing_schema',samples:1})).rejects.toThrow('No source tables');
   expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('off');
   await expect(collectPostgresBaseline(client,{schema,samples:1001})).rejects.toThrow('Samples');
  }finally{client.release();}
 });
 it('publishes a private CLI artifact without overwriting reports or leaving partial files on failure',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'videoq-baseline-test-')),output=join(directory,'baseline.json');
  const run=(path:string,sourceSchema=schema)=>promisify(execFile)(process.execPath,['--import','tsx','scripts/d1-baseline.ts','--output',path,'--schema',sourceSchema,'--samples','1'],{env:{...process.env,DATABASE_URL:url}});
  try{
   const result=await run(output);expect(result.stdout+result.stderr).not.toMatch(/private-.*canary|postgresql:\/\//);
   const original=await readFile(output,'utf8');expect(JSON.parse(original).tables).toHaveLength(3);expect((await stat(output)).mode&0o777).toBe(0o600);
   await expect(run(output)).rejects.toThrow();expect(await readFile(output,'utf8')).toBe(original);
   await expect(run(join(directory,'failed.json'),'missing_schema')).rejects.toThrow();expect(await readdir(directory)).toEqual(['baseline.json']);
  }finally{await rm(directory,{recursive:true,force:true});}
 },20000);
});
