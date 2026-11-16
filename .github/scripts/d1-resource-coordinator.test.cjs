const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createResourceCoordinator}=require('./d1-resource-coordinator.cjs');
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
function fixture({lostResponse=false,unknown=false,failApply=false,enabled=true}={}){
 const steps=[],stored=new Map(),applied=new Set(),calls=[];
 const journal={inspect:async()=>({steps:structuredClone(steps),nextStep:steps.at(-1)?.state==='intent'?steps.at(-1).step:RESOURCE_STEPS[steps.length]??null}),begin:async value=>{
  const found=steps.find(r=>r.step===value.step);if(found){if(found.planSha256!==value.planSha256)throw Error('RESOURCE_STEP_PLAN_CHANGED');return found;}
  const record={...value,state:'intent',operationId:'owned-operation'};steps.push(record);return record;
 },assertPending:async value=>{const record=steps.at(-1);assert.equal(record.step,value.step);assert.equal(record.state,'intent');assert.equal(record.planSha256,value.planSha256);},verify:async value=>{const record=steps.at(-1);record.state='verified';record.receiptSha256=value.receiptSha256;}};
 const adapters=Object.fromEntries(RESOURCE_STEPS.map(step=>[step,{
  prepare:async()=>{calls.push('prepare:'+step);return{step,original:'private non-secret plan'};},
  probe:async()=>{calls.push('probe:'+step);return unknown?{state:'unknown'}:applied.has(step)?{state:'applied',receiptSha256:resourceDigest({step})}:{state:'not-applied'};},
  apply:async(_plan,context)=>{await context.assertOwnership();calls.push('apply:'+step);if(failApply)throw Error('PRIVATE PROVIDER BODY');applied.add(step);if(lostResponse){lostResponse=false;throw Error('PRIVATE LOST RESPONSE');}},
 }]));
 const options={journal,adapters,plans:{load:async step=>stored.has(step)?structuredClone(stored.get(step)):null,save:async(step,plan)=>{stored.set(step,structuredClone(plan));}},assertEnvironment:async()=>{},enabled};
 return{calls,steps,stored,options,coordinator:createResourceCoordinator(options)};
}
test('all fixed adapters and environmental ownership checks are mandatory',()=>{
 const f=fixture();delete f.options.adapters[RESOURCE_STEPS.at(-1)];assert.throws(()=>createResourceCoordinator(f.options),/COMPLETE/);
});
test('disabled coordinator performs no observation or mutation',async()=>{
 const f=fixture({enabled:false});await assert.rejects(f.coordinator.runNext(),/DISABLED/);assert.deepEqual(f.calls,[]);
});
test('full ordered engine persists plans before applying and never releases the hold',async()=>{
 const f=fixture();for(const step of RESOURCE_STEPS){assert.deepEqual(await f.coordinator.runNext(),{status:'verified',step,holdReleased:false});assert.ok(f.stored.has(step));}
 assert.deepEqual(await f.coordinator.runNext(),{status:'steps-verified',holdReleased:false});assert.equal(f.calls.filter(v=>v.startsWith('apply:')).length,RESOURCE_STEPS.length);
});
test('lost mutation response reconciles without repeating an apply',async()=>{
 const f=fixture({lostResponse:true});await f.coordinator.runNext();assert.equal(f.steps[0].state,'verified');assert.equal(f.calls.filter(v=>v.startsWith('apply:')).length,1);
});
test('unknown state stops before mutation and leaves the durable intent',async()=>{
 const f=fixture({unknown:true});await assert.rejects(f.coordinator.runNext(),/RECONCILIATION/);assert.equal(f.steps[0].state,'intent');assert.ok(!f.calls.some(v=>v.startsWith('apply:')));
});
test('failed apply is not retried within an invocation or exposed as a provider error',async()=>{
 const f=fixture({failApply:true});await assert.rejects(f.coordinator.runNext(),{message:'RESOURCE_STEP_NOT_APPLIED'});assert.equal(f.calls.filter(v=>v.startsWith('apply:')).length,1);assert.equal(f.steps[0].state,'intent');
});
test('a lost original private plan cannot be reconstructed from changed external state',async()=>{
 const f=fixture({unknown:true});await assert.rejects(f.coordinator.runNext());f.stored.clear();const prepares=f.calls.filter(v=>v.startsWith('prepare:')).length;
 await assert.rejects(f.coordinator.runNext(),/PRIVATE_PLAN_REQUIRED/);assert.equal(f.calls.filter(v=>v.startsWith('prepare:')).length,prepares);
});
test('a changed durable plan and a changed environment stop before any new apply',async()=>{
 const f=fixture({unknown:true});await assert.rejects(f.coordinator.runNext());f.stored.set(RESOURCE_STEPS[0],{changed:true});await assert.rejects(f.coordinator.runNext(),/PLAN_CHANGED/);assert.ok(!f.calls.some(v=>v.startsWith('apply:')));
 const g=fixture();g.options.assertEnvironment=async()=>{throw Error('RESOURCE_ENVIRONMENT_CHANGED');};await assert.rejects(createResourceCoordinator(g.options).runNext(),/ENVIRONMENT_CHANGED/);assert.deepEqual(g.calls,[]);
});

test('read-side provider errors and private file error bodies are sanitized',async()=>{
 const f=fixture();f.options.adapters[RESOURCE_STEPS[0]].probe=async()=>{throw Error('SYNTHETIC PRIVATE PROVIDER BODY');};
 await assert.rejects(createResourceCoordinator(f.options).runNext(),{message:'RESOURCE_COORDINATOR_FAILED'});
 assert.ok(!f.calls.some(v=>v.startsWith('apply:')));
});
test('explicit bounded progress leaves intent pending without treating it as verification',async()=>{
 const f=fixture();f.options.adapters[RESOURCE_STEPS[0]].apply=async()=>({pending:true});
 assert.deepEqual(await f.coordinator.runNext(),{status:'pending',step:RESOURCE_STEPS[0],holdReleased:false});assert.equal(f.steps[0].state,'intent');
});
