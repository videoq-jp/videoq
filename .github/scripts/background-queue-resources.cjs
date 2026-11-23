const {readFileSync}=require('node:fs');
const {join}=require('node:path');

function queuePlan(config){
  const names=new Set(config.queues.producers.map(row=>row.queue));
  for(const consumer of config.queues.consumers){names.add(consumer.queue);if(consumer.dead_letter_queue)names.add(consumer.dead_letter_queue);}
  const expected=['videoq-account-prod','videoq-account-dlq-prod','videoq-search-prod','videoq-search-dlq-prod'];
  if(names.size!==expected.length||expected.some(name=>!names.has(name)))throw new Error('Unexpected background queue scope');
  return expected.map(queue_name=>({queue_name,settings:{message_retention_period:queue_name.includes('-dlq-')?1209600:345600}}));
}

/** Only create missing queues. Existing resources are read back, never repurposed. */
async function ensureQueues(plan,request){
  const existing=[];
  for(let page=1;;page++){
    const rows=await request('GET',`?page=${page}&per_page=500`);
    if(!Array.isArray(rows)||rows.some(row=>typeof row.queue_name!=='string'||typeof row.queue_id!=='string'))throw new Error('Invalid queue listing');
    existing.push(...rows);
    if(rows.length<500)break;
    if(page>=10000)throw new Error('Queue listing pagination limit exceeded');
  }
  const result=[];
  for(const desired of plan){
    const found=existing.filter(row=>row.queue_name===desired.queue_name);
    if(found.length>1)throw new Error('Queue lookup returned an unexpected scope');
    const queue=found[0]??await request('POST','',desired);
    if(queue.queue_name!==desired.queue_name||typeof queue.queue_id!=='string'||!queue.queue_id)throw new Error('Queue creation returned an unexpected identity');
    const verified=await request('GET',`/${queue.queue_id}`);
    if(verified.queue_name!==desired.queue_name||verified.queue_id!==queue.queue_id)throw new Error('Queue read-back identity mismatch');
    if(!Number.isSafeInteger(verified.settings?.message_retention_period)||verified.settings.message_retention_period<desired.settings.message_retention_period)throw new Error(`Queue retention requires explicit review: ${desired.queue_name}`);
    result.push({name:desired.queue_name,created:!found.length});
  }
  return result;
}

if(require.main===module){
  throw Error("Queue resources are managed by infra/cloudflare; use the Cloudflare Infrastructure workflow.");
  (async()=>{
    const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
    if(!/^[a-f0-9]{32}$/.test(account||'')||!token)throw new Error('Cloudflare infrastructure credentials are required');
    const config=JSON.parse(readFileSync(join(__dirname,'../../infra/cloudflare-background.production.json'),'utf8'));
    const plan=queuePlan(config);
    const request=async(method,path,body)=>{
      const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/queues${path}`,{
        method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30_000),
      });
      if(!response.ok)throw new Error(`Cloudflare queue operation failed (${response.status})`);
      const payload=await response.json();if(!payload.success)throw new Error('Cloudflare queue operation was rejected');
      return payload.result;
    };
    console.log(JSON.stringify({queues:await ensureQueues(plan,request)}));
  })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={queuePlan,ensureQueues};
