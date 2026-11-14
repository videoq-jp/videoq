import {createD1Fixture} from './d1-fixture';
import {ltiRegistrationContract,seedLtiRegistrations} from './contracts/lti-registration.contract';
import type {Bindings} from '../../src/types/bindings';
ltiRegistrationContract('D1 workerd',async()=>{
  const f=await createD1Fixture();
  const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};
  try{
    await seedLtiRegistrations(async(sql,args=[])=>{
      if(sql==='INSERT INTO users(id) VALUES(?)')return execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)',[args[0],args[0],`${String(args[0])}@example.test`]);
      return execute(sql,args);
    });
    return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud',LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[]})} as Bindings,execute,dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
});
