import { accountIntegrationsContract } from './contracts/account-integrations.contract';
import { createD1Fixture } from './d1-fixture';
import type { Bindings } from '../../src/types/bindings';
accountIntegrationsContract('D1 workerd',async()=>{
  const f=await createD1Fixture();
  return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings,
    execute:async(sql,args=[])=>{await f.database.prepare(sql).bind(...args.map(v=>Array.isArray(v)?JSON.stringify(v):typeof v==='boolean'?Number(v):v)).run();},dispose:f.dispose};
});
