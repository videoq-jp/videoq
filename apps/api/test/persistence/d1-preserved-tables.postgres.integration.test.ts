import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
import {fingerprintPreservedTable,loadPreservedTablePolicy,readPreservationEvidence,buildPreservedTablePolicy} from '../../scripts/migrations/d1/preserved-tables';
import {exportPostgresArchive} from '../../scripts/migrations/d1/export';
import {verifyPostgresArchive} from '../../scripts/migrations/d1/verify-archive';
import {openVerifiedPostgresSource} from '../../scripts/migrations/d1/verified-postgres-source';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
const mapping=()=>buildMigrationManifest({dialect:'postgresql',tables:{app:{name:'app',columns:{id:{name:'id',type:'integer',notNull:true},data:{name:'data',type:'text',notNull:true}}}}},{dialect:'sqlite',tables:{app:{name:'app',columns:{id:{name:'id',type:'integer',notNull:true},data:{name:'data',type:'text',notNull:true}}}}});
const sha=(data:string)=>createHash('sha256').update(data).digest('base64');
describe.skipIf(!url)('backup-bound explicit legacy table exclusion',()=>{
 let fixture:Awaited<ReturnType<typeof isolatedPostgres>>,directory:string,schema:string,output:string,policyPath:string;
 beforeEach(async()=>{
  fixture=await isolatedPostgres(url!);schema=(await fixture.pool.query('SELECT current_schema() AS name')).rows[0].name;
  directory=await mkdtemp(join(tmpdir(),'videoq-preserved-test-'));output=join(directory,'app.videoq-export.ndjson');policyPath=join(directory,'policy.json');
  await fixture.pool.query("CREATE TABLE app(id integer PRIMARY KEY,data text NOT NULL);INSERT INTO app VALUES(1,'current-canary');CREATE TABLE retired(id serial PRIMARY KEY,secret text);INSERT INTO retired(secret) VALUES('legacy-private-canary')");
  const client=await fixture.pool.connect();let table;
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');table=await fingerprintPreservedTable(client,schema,'retired');await client.query('COMMIT');}finally{client.release();}
  const run='a'.repeat(32),dump='synthetic dump bytes',dumpRef={key:`verified/${run}/database.dump`,version_id:'dump-v1',bytes:Buffer.byteLength(dump),sha256_base64:sha(dump)};
  const manifest={version:1,status:'restored-and-retained',schemas:['public','drizzle','videoq_security','chat_memory'],inventory:{[`"${schema}"."app"`]:'1',[`"${schema}"."retired"`]:'1'},dump:dumpRef};
  const manifestText=JSON.stringify(manifest)+'\n',backup={run_id:run,manifest_version_id:'manifest-v1',manifest_sha256_base64:sha(manifestText),dump_sha256_base64:sha(dump)};
  const receipt={transport_integrity_verified:true,source_run_id:run,manifest_version_id:backup.manifest_version_id,manifest_sha256_base64:backup.manifest_sha256_base64,dump:dumpRef};
  const restore={retrieved_backup_restore_verified:true,row_counts_match:true,constraints_validated:true,network:'none',source_run_id:run,table_count:2};
  for(const [name,value] of Object.entries({'database.dump':dump,'verified-backup.json':manifestText,'download-verified.json':JSON.stringify(receipt),'restore-verified.json':JSON.stringify(restore),'policy.json':JSON.stringify({version:1,purpose:'preserve-legacy-outside-d1',source_schema:schema,mapping_sha256:createHash('sha256').update(JSON.stringify(mapping())).digest('hex'),backup,tables:[table]})}))await writeFile(join(directory,name),value,{mode:0o600});
 });
 afterEach(async()=>{await fixture?.dispose();await rm(directory,{recursive:true,force:true});});
 const run=async()=>{const policy=await loadPreservedTablePolicy(directory,policyPath,mapping()),client=await fixture.pool.connect();try{return await exportPostgresArchive(client,mapping(),output,{schema,preservedTables:policy});}finally{client.release();}};
 it('builds only an exact explicit list after matching the complete recovery inventory',async()=>{
  const evidence=await readPreservationEvidence(directory),client=await fixture.pool.connect();
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   expect((await buildPreservedTablePolicy(client,mapping(),['retired'],evidence,schema)).tables).toHaveLength(1);
   await expect(buildPreservedTablePolicy(client,mapping(),['app'],evidence,schema)).rejects.toThrow();
   await expect(buildPreservedTablePolicy(client,mapping(),['retired','retired'],evidence,schema)).rejects.toThrow();
   await expect(buildPreservedTablePolicy(client,mapping(),['missing'],evidence,schema)).rejects.toThrow();
   await expect(buildPreservedTablePolicy(client,mapping(),['retired'],{...evidence,inventory:{...evidence.inventory,[`"${schema}"."app"`]:'2'}},schema)).rejects.toThrow();
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('exports only mapped data, preserves exclusion provenance and omits legacy-owned sequences',async()=>{
  expect(await run()).toEqual({tables:1,rows:'1'});const result=await verifyPostgresArchive(output,mapping());
  expect(result.preserved_source_tables?.tables.map(table=>table.name)).toEqual(['retired']);expect(result.sequence_states).toEqual([]);
  expect(await readFile(output,'utf8')).toContain('current-canary');expect(await readFile(output,'utf8')).not.toContain('legacy-private-canary');
  expect((await fixture.pool.query('SELECT secret FROM retired')).rows[0].secret).toBe('legacy-private-canary');
 });
 it('verifies the same source snapshot only with the matching backup-bound policy',async()=>{
  await run();
  await expect(openVerifiedPostgresSource({connectionString:url!,archivePath:output,manifest:mapping(),sourceSchema:schema})).rejects.toThrow();
  const source=await openVerifiedPostgresSource({connectionString:url!,archivePath:output,manifest:mapping(),sourceSchema:schema,preservation:{backupDirectory:directory,policyPath}});
  try{expect(source.proof.source_snapshot_equality_verified).toBe(true);await source.assertLive();}finally{await source.dispose();}
  await fixture.pool.query("UPDATE retired SET secret='same-count-change'");
  await expect(openVerifiedPostgresSource({connectionString:url!,archivePath:output,manifest:mapping(),sourceSchema:schema,preservation:{backupDirectory:directory,policyPath}})).rejects.toThrow();
 });
 it.each(['changed-value','changed-structure','added-table','missing-table','current-dependency'] as const)('rejects %s before publishing any archive',async(kind)=>{
  if(kind==='changed-value')await fixture.pool.query("UPDATE retired SET secret='changed-private-canary'");
  if(kind==='changed-structure')await fixture.pool.query('ALTER TABLE retired ADD COLUMN unexpected text');
  if(kind==='added-table')await fixture.pool.query('CREATE TABLE extra_legacy(id integer)');
  if(kind==='missing-table')await fixture.pool.query('DROP TABLE retired');
  if(kind==='current-dependency')await fixture.pool.query('ALTER TABLE app ADD FOREIGN KEY(id) REFERENCES retired(id)');
  await expect(run()).rejects.toThrow();await expect(access(output)).rejects.toThrow();
 });
 it.each(['dump','manifest','restore','mapped-table','duplicate'] as const)('rejects invalid %s evidence',async(kind)=>{
  if(kind==='dump')await writeFile(join(directory,'database.dump'),'tampered');
  if(kind==='manifest')await writeFile(join(directory,'verified-backup.json'),'{}');
  if(kind==='restore')await writeFile(join(directory,'restore-verified.json'),JSON.stringify({retrieved_backup_restore_verified:false}));
  if(kind==='mapped-table'||kind==='duplicate'){const policy=JSON.parse(await readFile(policyPath,'utf8'));if(kind==='mapped-table')policy.tables[0].name='app';else policy.tables.push(policy.tables[0]);await writeFile(policyPath,JSON.stringify(policy));}
  await expect(run()).rejects.toThrow();await expect(access(output)).rejects.toThrow();
 });
 it('keeps the default unknown-table rejection and rejects fabricated unchecked policy objects',async()=>{
  const client=await fixture.pool.connect();try{
   await expect(exportPostgresArchive(client,mapping(),output,{schema})).rejects.toThrow();
   const forged=JSON.parse(await readFile(policyPath,'utf8'));
   await expect(exportPostgresArchive(client,mapping(),output,{schema,preservedTables:forged})).rejects.toThrow();
  }finally{client.release();}
 });
});
