import {createD1Fixture} from './d1-fixture';
import {teachingContract,seedTeaching} from './contracts/teaching.contract';
import {createTeachingRepository} from '../../src/persistence/factory';
import type {Bindings} from '../../src/types/bindings';
teachingContract('D1 workerd',async()=>{
 const f=await createD1Fixture();
 const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};
 try{
  await seedTeaching(execute);const env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
  return {env,repository:await createTeachingRepository(env),execute,failConnect:()=>execute("CREATE TRIGGER reject_teaching BEFORE INSERT ON teaching_connections BEGIN SELECT RAISE(ABORT,'injected failure'); END"),count:async(table:string)=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')),dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
});
