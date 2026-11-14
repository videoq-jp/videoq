import {createD1Fixture} from './d1-fixture';
import {lmsResourceReadContract,seedLmsResourceRead} from './contracts/lms-resource-read.contract';
import type {Bindings} from '../../src/types/bindings';
lmsResourceReadContract('D1 workerd',async()=>{
 const f=await createD1Fixture();const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{
  await seedLmsResourceRead(async(sql,args=[])=>sql==='INSERT INTO users(id) VALUES(?)'
   ?execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)',[args[0],args[0],`${String(args[0])}@example.test`]):execute(sql,args));
  return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings,execute,dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
});
