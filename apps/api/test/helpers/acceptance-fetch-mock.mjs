/** Fixed offline subprocess preload; configuration is data, never generated JavaScript. */
import assert from 'node:assert/strict';
import {realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {acceptanceAccount} from '../../scripts/acceptance/io-boundary.mjs';
const directory=realpathSync(process.env.ACCEPTANCE_PRIVATE_DIR);
const mode=process.env.ACCEPTANCE_MOCK_MODE;assert(['status','analytics','forbid'].includes(mode));
const calls=[];
globalThis.fetch=(url,init)=>{
 if(mode==='forbid'){writeFileSync(join(directory,'network-attempt'),'unexpected');throw Error('Network forbidden');}
 if(mode==='analytics'){
  assert.equal(url,'https://api.cloudflare.com/client/v4/graphql');assert.equal(init.redirect,'error');
  return Promise.resolve(Response.json({data:{viewer:{accounts:[{d1QueriesAdaptiveGroups:[{dimensions:{databaseId:'ca70322e-c692-44b2-9052-de5d01a60e61',query:'SELECT fixture-private-sql'},count:1,sum:{queryDurationMs:2,rowsRead:3,rowsWritten:0,rowsReturned:1,unexpected:'private-not-public'},avg:{queryDurationMs:2,rowsRead:3,rowsWritten:0,rowsReturned:1}}]}]}}}));
 }
 assert(String(url).startsWith('https://api.cloudflare.com/client/v4/accounts/'+acceptanceAccount+'/'),'Unexpected network destination');
 calls.push({url:String(url),method:init.method,redirect:init.redirect});writeFileSync(join(directory,'requests.json'),JSON.stringify(calls));
 return Promise.resolve(Response.json({success:true,result:String(url).includes('/d1/database/')?{name:'videoq-acceptance-20261125-c33d'}:{id:'synthetic',status:'complete'}}));
};
