import {randomUUID} from 'node:crypto';
import type {D1Database} from '@cloudflare/workers-types';
import {describe,it,expect} from 'vitest';
import {createD1Fixture} from './d1-fixture';
import {prepareD1WriteFence,installD1WriteFence,inspectD1WriteFence,releaseD1WriteFence,type D1WriteFenceConnection} from '../../scripts/migrations/d1/write-fence';
const databaseId='00000000-0000-4000-8000-000000000001';
const operation=()=>randomUUID().replaceAll('-','');
async function fixture(){
 const f=await createD1Fixture(),connection={database:f.database,databaseId};
 const tables=(await f.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{name:string}>()).results.map(r=>r.name).filter(n=>!n.startsWith('_cf_')&&!n.startsWith('sqlite_'));
 return {...f,connection,tables};
}
describe('D1 row-write fence with actual migrations',()=>{
 it('blocks pre-prepared writes, replacement and batches; keeps reads; restores writes only on release',async()=>{
  const f=await fixture();try{
   const db=f.database;await db.prepare("INSERT INTO users(id,email,username,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('fence-user','fence@example.invalid','fence-user',0,0,0,0)").run();
   const old=db.prepare("UPDATE users SET name='old invocation' WHERE id='fence-user'"),plan=await prepareD1WriteFence(f.connection,f.tables,operation());
   expect((await inspectD1WriteFence(f.connection,plan)).state).toBe('open');
   expect((await installD1WriteFence(f.connection,plan)).installedTriggers).toBe(f.tables.length*3);
   expect((await installD1WriteFence(f.connection,plan)).state).toBe('fenced');
   for(const statement of [old,db.prepare("DELETE FROM users WHERE id='fence-user'"),db.prepare("INSERT OR REPLACE INTO users(id,email,username,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('fence-user','fence@example.invalid','fence-user',0,0,0,0)"),db.prepare("INSERT INTO mutation_receipts(token,kind,resource_id) VALUES ('blocked','probe',0)")])await expect(statement.run()).rejects.toThrow('VIDEOQ_MIGRATION_WRITES_FENCED');
   await expect(db.batch([db.prepare('CREATE TABLE fence_rollback_probe(value TEXT)'),old])).rejects.toThrow('VIDEOQ_MIGRATION_WRITES_FENCED');
   expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='fence_rollback_probe'").first()).toBeNull();
   expect(await db.prepare("SELECT name FROM users WHERE id='fence-user'").first('name')).toBe('');
   expect(await db.prepare('SELECT count(*) n FROM mutation_receipts').first('n')).toBe(0);
   expect((await releaseD1WriteFence(f.connection,plan)).state).toBe('open');await old.run();expect(await db.prepare("SELECT name FROM users WHERE id='fence-user'").first('name')).toBe('old invocation');
   expect((await releaseD1WriteFence(f.connection,plan)).state).toBe('open');
  }finally{await f.dispose();}
 });
 it('resumes interrupted install/release without treating a partial fence as complete',async()=>{
  const f=await fixture();try{
   const plan=await prepareD1WriteFence(f.connection,f.tables,operation());let calls=0;
   const flaky:D1WriteFenceConnection={databaseId,database:{prepare:f.connection.database.prepare.bind(f.connection.database),batch:async statements=>{if(++calls===2)throw new Error('synthetic interrupted batch');return f.connection.database.batch(statements);}} as D1Database};
   await expect(installD1WriteFence(flaky,plan)).rejects.toThrow('synthetic interrupted batch');const partial=await inspectD1WriteFence(f.connection,plan);expect(partial.state).toBe('partial');expect(partial.installedTriggers).toBe(20);
   expect((await installD1WriteFence(f.connection,plan)).state).toBe('fenced');calls=0;await expect(releaseD1WriteFence(flaky,plan)).rejects.toThrow('synthetic interrupted batch');expect((await inspectD1WriteFence(f.connection,plan)).state).toBe('partial');
   expect((await releaseD1WriteFence(f.connection,plan)).state).toBe('open');
  }finally{await f.dispose();}
 });
 it('rejects missing tables, schema drift, wrong identity and conflicting operations before changing schema',async()=>{
  const f=await fixture();try{
   await expect(prepareD1WriteFence(f.connection,f.tables.slice(1),operation())).rejects.toThrow('inventory mismatch');const plan=await prepareD1WriteFence(f.connection,f.tables,operation());
   await expect(installD1WriteFence({...f.connection,databaseId:'00000000-0000-4000-8000-000000000002'},plan)).rejects.toThrow('identity mismatch');expect((await inspectD1WriteFence(f.connection,plan)).state).toBe('open');
   await installD1WriteFence(f.connection,plan);await expect(prepareD1WriteFence(f.connection,f.tables,operation())).rejects.toThrow('already exists');await expect(installD1WriteFence(f.connection,{...plan,operationId:operation()})).rejects.toThrow('Unknown or modified');
   await f.database.prepare('CREATE INDEX fence_test_index ON users(name)').run();await expect(inspectD1WriteFence(f.connection,plan)).rejects.toThrow('schema drift');await f.database.prepare('DROP INDEX fence_test_index').run();await releaseD1WriteFence(f.connection,plan);
  }finally{await f.dispose();}
 });
 it('rejects a matching trigger name with a weakened body',async()=>{
  const f=await fixture();try{
   const plan=await prepareD1WriteFence(f.connection,f.tables,operation());await installD1WriteFence(f.connection,plan);
   const row=await f.database.prepare("SELECT name,tbl_name FROM sqlite_master WHERE type='trigger' AND name LIKE 'videoq_migration_fence_%' LIMIT 1").first<{name:string;tbl_name:string}>();expect(row).not.toBeNull();
   await f.database.prepare('DROP TRIGGER "'+row!.name+'"').run();await f.database.prepare('CREATE TRIGGER "'+row!.name+'" BEFORE INSERT ON "'+row!.tbl_name+'" BEGIN SELECT 1; END').run();
   await expect(inspectD1WriteFence(f.connection,plan)).rejects.toThrow('Unknown or modified');await expect(releaseD1WriteFence(f.connection,plan)).rejects.toThrow('Unknown or modified');
  }finally{await f.dispose();}
 });
});
