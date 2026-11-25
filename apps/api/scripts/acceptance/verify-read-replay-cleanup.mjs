/** Independent read-only verification of both specifically authorized replay databases. */
import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';
const directory=process.env.ACCEPTANCE_PRIVATE_DIR;assert(directory);
const account='12daec56fdba43f677f2766ee26a5a39';
const token=process.env.CLOUDFLARE_API_TOKEN??readFileSync(process.env.HOME+'/Library/Preferences/.wrangler/config/default.toml','utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];assert(token);
const results=[];
for(const [file,name]of [['read-replay-schema-failure.json','videoq-acceptance-20261125-c33d-reads'],['read-replay-report.json','videoq-acceptance-20261125-c33d-reads2']]){
 const report=JSON.parse(readFileSync(directory+'/'+file,'utf8'));assert.equal(report.account,account);assert.equal(report.name,name);assert(/^[a-f0-9-]{36}$/.test(report.database));
 const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database/'+report.database,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+token}});
 const value=await response.json();const codes=value.errors?.map(row=>row.code);results.push({name,database:report.database,status:response.status,codes,absent:response.status===404&&codes.includes(7404)});
}
const result={verifiedAt:new Date().toISOString(),account,readOnly:true,databases:results,allAbsent:results.every(row=>row.absent)};writeFileSync(directory+'/read-replay-independent-cleanup.json',JSON.stringify(result,null,2)+'\n');assert(result.allAbsent);console.log(JSON.stringify(result));
