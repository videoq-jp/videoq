import {expect,it} from 'vitest';
import {courseReport} from '../../src/features/lti/course-reports';
import {digest} from '../../src/features/lti/store';
import {createD1Fixture} from './d1-fixture';
import {courseReportContract,seedReport,reportPeriod} from './contracts/course-report.contract';
import {seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
async function setup(){
 const f=await createD1Fixture(),env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
 const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{return {env,execute,...await seedHistory(env,execute),dispose:f.dispose,
  audits:async()=>(await f.database.prepare('SELECT actor_key AS actorKey,resource_count AS resourceCount,scope_hash AS scopeHash FROM lti_report_accesses').all<{actorKey:string;resourceCount:number;scopeHash:string}>()).results,
  failAudit:()=>execute("CREATE TRIGGER reject_audit BEFORE INSERT ON lti_report_accesses BEGIN SELECT RAISE(ABORT,'audit failure'); END")};
 }catch(error){await f.dispose();throw error;}
}
courseReportContract('D1 workerd',setup);

function beforeNextBatch(database:D1Database,hook:()=>Promise<void>):D1Database{
 let pending=true;
 return new Proxy(database,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(pending){pending=false;await hook();}return target.batch(statements);};
  const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
it('retries a D1 scope changed between preparation and the audit batch without saving a stale receipt',async()=>{
 const f=await setup();try{
  const scope=await seedReport(f);
  f.env.DB=beforeNextBatch(f.env.DB!,()=>f.execute('DELETE FROM video_course_members WHERE course_id=? AND video_id=?',[f.courseId,f.videoIds[1]]));
  expect((await courseReport(f.env,scope,reportPeriod)).totals.questions).toBe(0);
  expect(await f.audits()).toEqual([{actorKey:expect.any(String),resourceCount:1,scopeHash:await digest(JSON.stringify([f.videoIds[0]]))}]);
 }finally{await f.dispose();}
});
it('rejects D1 session revocation immediately before the audit batch',async()=>{
 const f=await setup();try{
  const scope=await seedReport(f);
  f.env.DB=beforeNextBatch(f.env.DB!,()=>f.execute('DELETE FROM lti_credentials WHERE id=?',[scope.sessionProof.sessionHash]));
  await expect(courseReport(f.env,scope,reportPeriod)).rejects.toMatchObject({status:403});expect(await f.audits()).toEqual([]);
 }finally{await f.dispose();}
});
