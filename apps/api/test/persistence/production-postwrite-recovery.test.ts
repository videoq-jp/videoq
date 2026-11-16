import {describe,it,expect,vi,beforeEach} from 'vitest';
const hook=vi.hoisted(()=>({transaction:vi.fn()}));
vi.mock('../../scripts/migrations/d1/fenced-postgres-transaction',()=>({withPostgresLoginFenceTransaction:hook.transaction}));
import {restoreProductionPostwriteSnapshot,recoveryHash,type RecoveryRows} from '../../scripts/migrations/d1/postwrite-recovery';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
import type {PostgresLoginFencePlan} from '../../scripts/migrations/d1/postgres-login-fence';
const target={purpose:'production' as const,host:'ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech' as const,databaseName:'neondb' as const,rolePrefix:'videoq_' as const};
function input(){
 const names=['mutation_receipts','scene_staging','scene_index_tasks','scene_index_runs','visual_object_attempts','ai_answer_attempts','job_executions','external_tasks','chat_conversations','video_course_invitations','video_visual_chunks','video_visual_runs','videos','scenes','video_index_heads','video_index_versions','conversation_checkpoints','conversation_checkpoint_writes'];
 const rows=Object.fromEntries(names.map(n=>[n,[]])) as RecoveryRows;
 const manifest={...buildMigrationManifest({dialect:'postgresql',tables:{}},{dialect:'sqlite',tables:{}}),target_insert_order:names};
 const plan:PostgresLoginFencePlan={version:1,operationId:'00000000-0000-4000-8000-000000000001',target,roles:[{oid:42,name:'videoq_api_synthetic',can_login:true,superuser:false,create_db:false,create_role:false,replication:false,bypass_rls:false,inherit:true,connection_limit:-1,valid_until:null}],memberships:[],catalogSha256:'a'.repeat(64)};
 return{rows,vectors:[],manifest,plan,upstreamStopped:true,connectionString:'postgresql://admin:synthetic@'+target.host+'/neondb?sslmode=verify-full',sequenceHighWater:{},expectedSnapshotSha256:recoveryHash({rows,vectors:[],sequenceHighWater:{},visualRecovery:null}),expectedManifestSha256:recoveryHash(manifest)};
}
beforeEach(()=>{hook.transaction.mockReset();});
describe('fixed production recovery entry',()=>{
 it('rejects changed input, mapping, missing upstream stop and isolated targets before transaction entry',async()=>{
  for(const change of [(v:ReturnType<typeof input>)=>{v.rows.videos.push({id:7});},(v:ReturnType<typeof input>)=>{v.expectedManifestSha256='b'.repeat(64);},(v:ReturnType<typeof input>)=>{v.upstreamStopped=false;},(v:ReturnType<typeof input>)=>{v.plan.target={purpose:'isolated-rehearsal',host:'127.0.0.1',databaseName:'recovery_'+'a'.repeat(32),rolePrefix:'recovery_'+'a'.repeat(32)+'_'};}]){
   const value=input();change(value);await expect(restoreProductionPostwriteSnapshot(value)).rejects.toThrow();
  }
  expect(hook.transaction).not.toHaveBeenCalled();
 });
 it('uses fixed schemas inside the verified transaction without starting a nested transaction',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[]}),value=input();
  hook.transaction.mockImplementation(async options=>{expect(options.connectionString).toBe(value.connectionString);expect(options.plan.target).toEqual(target);expect(options.upstreamStopped).toBe(true);return options.operation({query,connectionParameters:{host:target.host}});});
  const result=await restoreProductionPostwriteSnapshot(value);
  expect(result.postgresLoginFenceVerified).toBe(true);expect(result.productionSafe).toBe(false);
  const sql=query.mock.calls.map(c=>String(c[0]));expect(sql.some(s=>/\b(BEGIN|COMMIT|ROLLBACK)\b/.test(s))).toBe(false);expect(sql.some(s=>s.includes('"chat_memory"."checkpoints"'))).toBe(true);
 });
 it('pins an independent input copy before waiting for the fenced connection',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[]}),value=input();
  hook.transaction.mockImplementation(async options=>{value.rows.ai_answer_attempts.push({status:'started'});return options.operation({query,connectionParameters:{host:target.host}});});
  await expect(restoreProductionPostwriteSnapshot(value)).resolves.toHaveProperty('postgresLoginFenceVerified',true);
 });
});
