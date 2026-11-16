const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceConsumerAdapters}=require('./d1-resource-consumers.cjs');
function fixture(){
 const names=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'],rows=names.map((name,i)=>({FunctionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+name,EventSourceArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+name,UUID:`00000000-0000-0000-0000-00000000000${i}`,State:i===2?'Disabled':'Enabled'})),plans=new Map(),writes=[];
 let lost=false,safe=true;
 const aws=async(command,input)=>{if(command==='ListEventSourceMappings'){assert.ok(names.includes(input.FunctionName));return{EventSourceMappings:[{...rows[names.indexOf(input.FunctionName)]}]};}assert.equal(command,'UpdateEventSourceMapping');const row=rows.find(r=>r.UUID===input.UUID);assert.ok(row);writes.push(input);row.State=input.Enabled?'Enabled':'Disabled';if(lost){lost=false;throw Error('lost');}return{};};
 const options={aws,plans:{load:async step=>plans.get(step)??null},assertBackendSafe:async()=>{if(!safe)throw Error('RESOURCE_BACKEND_UNSAFE');}},adapters=createResourceConsumerAdapters(options);
 return{rows,plans,writes,options,adapters,context:{assertOwnership:async()=>{}},lose:()=>lost=true,unsafe:()=>safe=false};
}
async function prepare(f){const p=await f.adapters['pause-consumers'].prepare();f.plans.set('pause-consumers',p);return p;}
test('pause and resume preserve the three fixed consumers original admission',async()=>{
 const f=fixture(),p=await prepare(f);assert.equal(f.writes.length,0);await f.adapters['pause-consumers'].apply(p,f.context);assert.equal((await f.adapters['pause-consumers'].probe(p)).state,'applied');assert.deepEqual(await f.adapters['resume-consumers'].prepare(),p);await f.adapters['resume-consumers'].apply(p,f.context);assert.equal((await f.adapters['resume-consumers'].probe(p)).state,'applied');assert.equal(f.rows[2].State,'Disabled');assert.equal(f.writes.length,4);
});
test('asynchronous admission transition is unknown and drift fails closed',async()=>{
 const f=fixture(),p=await prepare(f);f.rows[0].State='Disabling';assert.deepEqual(await f.adapters['pause-consumers'].probe(p),{state:'unknown'});await assert.rejects(f.adapters['resume-consumers'].probe(p),/STATE_DRIFT/);f.rows[0].State='Enabled';f.rows[2].State='Enabled';await assert.rejects(f.adapters['pause-consumers'].probe(p),/STATE_DRIFT/);assert.equal(f.writes.length,0);
});
test('partial lost response reconciles remaining mappings without replaying completed writes',async()=>{
 const f=fixture(),p=await prepare(f);f.lose();await assert.rejects(f.adapters['pause-consumers'].apply(p,f.context),/lost/);assert.equal((await f.adapters['pause-consumers'].probe(p)).state,'not-applied');await f.adapters['pause-consumers'].apply(p,f.context);assert.equal((await f.adapters['pause-consumers'].probe(p)).state,'applied');assert.equal(f.writes.length,2);
});
test('missing plan, missing safety check and lost ownership prohibit writes',async()=>{
 const f=fixture(),p=await prepare(f);assert.throws(()=>createResourceConsumerAdapters({...f.options,assertBackendSafe:undefined}),/CONTEXT/);f.plans.clear();await assert.rejects(f.adapters['pause-consumers'].apply(p,f.context),/ORIGINAL_PLAN/);f.plans.set('pause-consumers',p);await assert.rejects(f.adapters['pause-consumers'].apply(p,{assertOwnership:async()=>{throw Error('revoked');}}),/revoked/);f.unsafe();await assert.rejects(f.adapters['pause-consumers'].apply(p,f.context),/BACKEND_UNSAFE/);assert.equal(f.writes.length,0);
});
test('mapping replacement refuses both observation and mutation',async()=>{
 const f=fixture(),p=await prepare(f);f.rows[0].UUID='11111111-1111-1111-1111-111111111111';await assert.rejects(f.adapters['pause-consumers'].probe(p),/REPLACED/);await assert.rejects(f.adapters['pause-consumers'].apply(p,f.context),/REPLACED/);assert.equal(f.writes.length,0);
});
