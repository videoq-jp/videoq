import {createD1Fixture} from './d1-fixture';
import {privacyAuthorizationContract} from './contracts/privacy-authorization.contract';
import {seedSyncOwner} from './contracts/lms-resource-sync.contract';
import type {Bindings} from '../../src/types/bindings';
privacyAuthorizationContract('D1 workerd',async()=>{
 const f=await createD1Fixture(),execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{await seedSyncOwner(execute,{connectContext:false,installer:'owner'});return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings,execute,
  credentials:async()=>(await f.database.prepare('SELECT kind,payload FROM lti_credentials ORDER BY id').all<{kind:string;payload:string}>()).results.map(r=>({...r,payload:JSON.parse(r.payload) as Record<string,unknown>})),dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
});
