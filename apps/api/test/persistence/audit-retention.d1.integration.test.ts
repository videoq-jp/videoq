import {expect,it} from 'vitest';
import {createAuditRetentionRepository} from '../../src/persistence/factory';
import {createD1Fixture} from './d1-fixture';
import {auditRetentionContract,auditCutoff,insertExpiredTag} from './contracts/audit-retention.contract';
import {seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
async function setup(){
 const f=await createD1Fixture(),env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
 const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{
  const seeded=await seedHistory(env,execute);
  return {env,execute,...seeded,dispose:f.dispose,
   rows:async(table:import('./contracts/audit-retention.contract').AuditTable)=>(await f.database.prepare(`SELECT * FROM ${table}`).all<Record<string,unknown>>()).results,
   failDelete:()=>execute("CREATE TRIGGER reject_audit_delete BEFORE DELETE ON lti_course_tag_operations BEGIN SELECT RAISE(ABORT,'audit delete failure'); END"),
   seedBacklog:(count:number,at:string)=>execute("INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash,created_at) SELECT value,?,?,'create',?,? FROM json_each(?)",[seeded.courseId,'e'.repeat(64),'a'.repeat(64),at,JSON.stringify(Array.from({length:count},()=>crypto.randomUUID()))])};
 }catch(error){await f.dispose();throw error;}
}
auditRetentionContract('D1 workerd',setup);

function beforeNextBatch(database:D1Database,hook:()=>Promise<void>):D1Database{
 let pending=true;
 return new Proxy(database,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(pending){pending=false;await hook();}return target.batch(statements);};
  const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}

it('does not retire a D1 receipt whose timestamp changed after selection',async()=>{
 const f=await setup();try{
  const id=await insertExpiredTag(f);
  f.env.DB=beforeNextBatch(f.env.DB!,()=>f.execute('UPDATE lti_course_tag_operations SET created_at=? WHERE id=?',[auditCutoff.toISOString(),id]));
  expect(await (await createAuditRetentionRepository(f.env)).pruneBatch('tag',auditCutoff)).toEqual({count:0,more:false});
  expect(await f.rows('lti_course_tag_operations')).toHaveLength(1);expect(await f.rows('lti_operation_reservations')).toHaveLength(0);
 }finally{await f.dispose();}
});
it('uses the D1 retention indexes for bounded candidate selection',async()=>{
 const f=await setup();try{
  for(const [table,index,filter] of [
   ['lti_material_operations','lti_material_ops_retention_idx',''],['lti_course_tag_operations','lti_course_tag_ops_retention_idx',''],
   ['lti_report_accesses','lti_report_accesses_retention_idx',''],['course_qa_moderation','course_qa_moderation_retention_idx','lti_actor_id IS NOT NULL AND '],
  ]){
   const plan=await f.env.DB!.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE ${filter}created_at<? ORDER BY created_at,id LIMIT 500`).bind(auditCutoff.toISOString()).all<{detail:string}>();
   expect(plan.results.map(row=>row.detail).join(' ')).toContain(index);
  }
 }finally{await f.dispose();}
});
