import {describe,it,expect,vi} from 'vitest';
import type pg from 'pg';
import {reverseMigrationValue,recoveryHash,canonicalRecoveryJson,restorePostwriteSnapshot,type RecoveryRows} from '../../scripts/migrations/d1/postwrite-recovery';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
describe('bounded postwrite recovery',()=>{
 it('converts SQLite values to typed PG parameters without losing SQL NULL',()=>{
  expect(reverseMigrationValue(1,'boolean_integer',false)).toBe(true);
  expect(reverseMigrationValue(0,'boolean_integer',false)).toBe(false);
  expect(reverseMigrationValue(null,'json_text',true)).toBeNull();
  expect(reverseMigrationValue('null','json_text',true)).toBe('null');
  expect(reverseMigrationValue('["日本語",null]','text_array_json',false)).toEqual(['日本語',null]);
  expect(reverseMigrationValue('2026-11-15T01:02:03.123Z','utc_timestamp',false)).toBe('2026-11-15T01:02:03.123Z');
  expect(reverseMigrationValue('{"n":9007199254740993}','json_text',false)).toBe('{"n":9007199254740993}');
 });
 it.each([2,-1,'1',true,null])('rejects invalid nonnullable boolean %s',v=>expect(()=>reverseMigrationValue(v,'boolean_integer',false)).toThrow());
 it.each([NaN,Infinity,9007199254740992,'42'])('rejects unsafe or nonnumeric integer %s',v=>expect(()=>reverseMigrationValue(v,'safe_integer',false)).toThrow());
 it('rejects malformed UUID, timezone-free timestamps, array members and nonfinite reals',()=>{
  for(const [value,type] of [['bad','uuid'],['2026-01-01T00:00:00','utc_timestamp'],['[1]','text_array_json'],[Infinity,'finite_real']] as const)expect(()=>reverseMigrationValue(value,type,false)).toThrow();
 });
 it('hashes object key order consistently while retaining array order',()=>{
  expect(recoveryHash({b:2,a:1})).toBe(recoveryHash({a:1,b:2}));expect(recoveryHash([1,2])).not.toBe(recoveryHash([2,1]));
 });
 it('rejects remote hosts and arbitrary schemas before SQL is issued',async()=>{
  const query=vi.fn(),client={query,connectionParameters:{host:'production.example.invalid'}} as unknown as pg.Client;
  const manifest=buildMigrationManifest({dialect:'postgresql',tables:{}},{dialect:'sqlite',tables:{}});
  const schema='recovery_'+'a'.repeat(32),base={client,schema,checkpointSchema:schema+'_chat',manifest,rows:{} as RecoveryRows,vectors:[],writersFenced:true};
  await expect(restorePostwriteSnapshot(base)).rejects.toThrow('Only local');
  await expect(restorePostwriteSnapshot({...base,schema:'public'})).rejects.toThrow('Isolated');
  await expect(restorePostwriteSnapshot({...base,writersFenced:false})).rejects.toThrow('stopped writers');expect(query).not.toHaveBeenCalled();
 });
 it.each(['ai_answer_attempts','job_executions','external_tasks','chat_conversations','scene_index_tasks','video_course_invitations'])('refuses active work in %s before SQL',async(table)=>{
  const query=vi.fn(),client={query,connectionParameters:{host:'127.0.0.1'}} as unknown as pg.Client;
  const names=['mutation_receipts','scene_staging','scene_index_tasks','scene_index_runs','visual_object_attempts','ai_answer_attempts','job_executions','external_tasks','chat_conversations','video_course_invitations','video_visual_chunks','video_visual_runs'];
  const manifest={...buildMigrationManifest({dialect:'postgresql',tables:{}},{dialect:'sqlite',tables:{}}),target_insert_order:names};
  const rows=Object.fromEntries(names.map(n=>[n,[]])) as RecoveryRows;
  rows[table]=[{status:table==='ai_answer_attempts'?'started':'running',lease_token:'held',lease_id:'held',leased_until:'2099',creation_nonce:'held'}];
  const schema='recovery_'+'a'.repeat(32);
  await expect(restorePostwriteSnapshot({client,schema,checkpointSchema:schema+'_chat',manifest,rows,vectors:[],writersFenced:true})).rejects.toThrow();expect(query).not.toHaveBeenCalled();
 });

 it('compares JSONB formatting while distinguishing integers beyond JS precision',()=>{
  expect(canonicalRecoveryJson('{"n":1e3,"x":1.00}')).toEqual(canonicalRecoveryJson('{"x":1,"n":1000}'));
  expect(canonicalRecoveryJson('{"n":9007199254740993}')).not.toEqual(canonicalRecoveryJson('{"n":9007199254740992}'));
  expect(canonicalRecoveryJson('null')).not.toEqual(canonicalRecoveryJson('"null"'));
 });

});
