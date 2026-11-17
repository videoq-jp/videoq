const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceE2eAdapter}=require('./d1-resource-e2e.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
async function fixture(){
 let version='11111111-1111-1111-1111-111111111111',status={state:'not-started'},starts=0;
 const settings={compatibility_date:'2026-08-20',bindings:[{name:'DB',type:'d1',id:'587bd210-6d9d-4f32-abb7-a490013e65d3'},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:'videoq-prod-scenes-1536'},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:'videoq-prod-scenes-768'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'running'}]};
 const cloudflare=async(method,path)=>{assert.equal(method,'GET');if(path.endsWith('/deployments'))return{deployments:[{id:version,versions:[{version_id:version,percentage:100}]}]};if(path.endsWith('/versions?per_page=1'))return{items:[{id:version}]};return structuredClone(settings);};
 const resumed=await createApiTrafficControl(cloudflare).prepare({purpose:'production'}),promotion={targetBindingsHash:resumed.bindingsHash};
 const plans=new Map([['resume-api',resumed],['promote-bindings',promotion]]);
 const state={nextStep:'verify-e2e',steps:RESOURCE_STEPS.slice(0,10).map(step=>({step,state:'verified',planSha256:resourceDigest(plans.get(step)??{step})}))};
 const adapter=createResourceE2eAdapter({journal:{assertExecutor:async()=>{},inspect:async()=>structuredClone(state)},plans:{load:async name=>structuredClone(plans.get(name))},cloudflare,proof:{prepare:async notBefore=>({notBefore})},launcher:{observe:async()=>structuredClone(status),advance:async()=>{starts++;status={state:'pending'};}},now:()=> '2026-11-17T00:00:00.000Z'});
 return{adapter,state,settings,plans,get starts(){return starts;},setStatus:v=>status=v,changeVersion:()=>version='22222222-2222-2222-2222-222222222222'};
}
test('E2E starts through owned launcher, waits for native completion and links receipt to stable target API',async()=>{
 const f=await fixture(),plan=await f.adapter.prepare();assert.equal(plan.nativePlan.notBefore,'2026-11-17T00:00:00.000Z');assert.deepEqual(await f.adapter.probe(plan),{state:'not-applied'});
 await f.adapter.apply(plan,{assertOwnership:async()=>{}});assert.equal(f.starts,1);assert.deepEqual(await f.adapter.probe(plan),{state:'not-applied'});
 const receipt={buildArn:'fixed',verifyAiAnswers:true};const native=resourceDigest(receipt);f.setStatus({state:'succeeded',proof:{receipt,receiptSha256:native}});
 assert.deepEqual(await f.adapter.probe(plan),{state:'applied',receiptSha256:resourceDigest({nativeReceiptSha256:native,apiVersion:plan.apiVersion,apiBindingsSha256:plan.apiBindingsSha256})});
});
test('stale Worker version, paused traffic, wrong DB and altered resume plans refuse E2E',async()=>{
 for(const mutate of [f=>f.changeVersion(),f=>f.settings.bindings[3].text='paused',f=>f.settings.bindings[0].id='old-db',f=>f.plans.get('resume-api').settingsHash='e'.repeat(64)]){const f=await fixture(),plan=await f.adapter.prepare();mutate(f);await assert.rejects(f.adapter.probe(plan));assert.equal(f.starts,0);}
});
test('failed native build cannot complete step or trigger restart during probe',async()=>{
 const f=await fixture(),plan=await f.adapter.prepare();f.setStatus({state:'failed'});assert.deepEqual(await f.adapter.probe(plan),{state:'unknown'});assert.equal(f.starts,0);
});
test('unregistered attempt remains available for metadata reconciliation; corrupt receipt refuses completion',async()=>{
 const f=await fixture(),plan=await f.adapter.prepare();f.setStatus({state:'unregistered'});assert.deepEqual(await f.adapter.probe(plan),{state:'not-applied'});
 f.setStatus({state:'succeeded',proof:{receipt:{changed:true},receiptSha256:'a'.repeat(64)}});await assert.rejects(f.adapter.probe(plan),/NATIVE_RECEIPT/);
});
test('all previous resource steps must be verified and ownership is checked before launch',async()=>{
 const f=await fixture();f.state.steps[7].state='intent';await assert.rejects(f.adapter.prepare(),/PRECEDING_STEPS/);
 const g=await fixture(),plan=await g.adapter.prepare();await assert.rejects(g.adapter.apply(plan,{assertOwnership:async()=>{throw Error('lost');}}),/lost/);assert.equal(g.starts,0);
});
