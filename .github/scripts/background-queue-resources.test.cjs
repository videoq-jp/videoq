const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {queuePlan,ensureQueues}=require('./background-queue-resources.cjs');
const config=require('../../infra/cloudflare-background.production.json');
function fixture(){
 const rows=new Map(),writes=[];
 const request=async(method,path,body)=>{
  if(method==='POST'){writes.push(body);const row={...body,queue_id:String(rows.size+1)};rows.set(row.queue_name,row);return row;}
  if(path.startsWith('?')){const page=Number(new URLSearchParams(path).get('page'));return [...rows.values()].slice((page-1)*500,page*500);}
  return [...rows.values()].find(row=>row.queue_id===path.slice(1));
 };
 return{rows,writes,request};
}
test('the approved plan creates only the four scoped queues and reads every identity back',async()=>{
 const f=fixture(),plan=queuePlan(config);
 assert.equal(plan.length,4);assert.equal(plan.filter(row=>row.settings.message_retention_period===1209600).length,2);
 const result=await ensureQueues(plan,f.request);assert.equal(result.filter(row=>row.created).length,4);
 await ensureQueues(plan,f.request);assert.equal(f.writes.length,4);
});
test('unexpected resources, identities or retention fail without altering existing queues',async()=>{
 assert.throws(()=>queuePlan({queues:{producers:[{queue:'unrelated'}],consumers:[]}}),/scope/);
 const f=fixture(),plan=queuePlan(config);await ensureQueues(plan,f.request);f.writes.length=0;
 f.rows.get(plan[0].queue_name).settings={message_retention_period:60};
 await assert.rejects(ensureQueues(plan,f.request),/retention requires explicit review/);assert.equal(f.writes.length,0);
 await assert.rejects(ensureQueues(plan,async()=>[{queue_name:plan[0].queue_name,queue_id:'one'},{queue_name:plan[0].queue_name,queue_id:'two'}]),/unexpected scope/);
});
test('resource preparation uses the existing production-infra approval gate and does not sync unrelated resources',()=>{
 const workflow=readFileSync('.github/workflows/cloudflare-resources.yml','utf8');
 assert.match(workflow,/environment: production-infra/);
 assert.match(workflow,/if: inputs.prepare_background_queues == true/);
 assert.match(workflow,/inputs.prepare_background_queues != true/);
});

test('pagination finds existing target queues after unrelated queues without recreating them',async()=>{
 const f=fixture(),plan=queuePlan(config);
 for(let i=0;i<500;i++)f.rows.set(`unrelated-${i}`,{queue_name:`unrelated-${i}`,queue_id:`unrelated-${i}`});
 await ensureQueues(plan,f.request);
 assert.equal(f.writes.length,4);
 const result=await ensureQueues(plan,f.request);
 assert.equal(result.every(row=>!row.created),true);
 assert.equal(f.writes.length,4);
});
