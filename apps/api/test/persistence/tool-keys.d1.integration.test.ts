import {createD1Fixture} from './d1-fixture';
import {toolKeysContract} from './contracts/tool-keys.contract';
import type {Bindings} from '../../src/types/bindings';
toolKeysContract('D1 workerd',async()=>{
  const f=await createD1Fixture();
  return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud',USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64url')} as Bindings,
    execute:async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();},
    count:async()=>Number(await f.database.prepare('SELECT count(*) AS n FROM lti_tool_keys').first('n')),dispose:f.dispose};
});
