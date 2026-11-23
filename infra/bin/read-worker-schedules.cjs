'use strict';
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
const WORKERS=['videoq-api','videoq-web','videoq-docs','videoq-maintenance-prod'];
function crons(result) {
 if(!result || !Array.isArray(result.schedules))throw Error('INVALID_CRON_RESPONSE');
 const values=result.schedules.map(row=>{if(typeof row.cron!=='string'||!row.cron.trim())throw Error('INVALID_CRON_RESPONSE');return row.cron;});
 if(new Set(values).size!==values.length)throw Error('DUPLICATE_CRON');
 return values.sort();
}
async function main(){
 JSON.parse(require('node:fs').readFileSync(0,'utf8'));
 if(!process.env.CLOUDFLARE_API_TOKEN)throw Error('CLOUDFLARE_API_TOKEN_REQUIRED');
 const rows=await Promise.all(WORKERS.map(async name=>{
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${name}/schedules`,{headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN},redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('CRON_READ_FAILED');const data=await response.json();if(data.success!==true)throw Error('CRON_READ_FAILED');return[name,crons(data.result)];
 }));
 process.stdout.write(JSON.stringify({schedules:JSON.stringify(Object.fromEntries(rows))}));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={crons};
