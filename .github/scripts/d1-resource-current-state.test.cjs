const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceCurrentState}=require('./d1-resource-current-state.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
const {createConsumerControl}=require('./cutover-sqs-consumers.cjs');
const {createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
async function fixture(){
 const run='a'.repeat(32),source='b'.repeat(40),version='11111111-1111-1111-1111-111111111111';
 const settings={bindings:[{name:'DB',type:'d1',id:'source-db'},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:'source-large'},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:'source-small'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'running'}],compatibility_date:'2026-08-20'};
 const cloudflare=async(method,path)=>{assert.equal(method,'GET');if(path.endsWith('/deployments'))return{deployments:[{id:version,versions:[{version_id:version,percentage:100}]}]};if(path.endsWith('/versions?per_page=1'))return{items:[{id:version}]};return structuredClone(settings);};
 const traffic=createApiTrafficControl(cloudflare,{assertOwnership:async()=>{},assertRestoreSafe:async()=>{}}),paused=await traffic.prepare({purpose:'production'});
 settings.bindings[0].id='587bd210-6d9d-4f32-abb7-a490013e65d3';settings.bindings[1].index_name='videoq-prod-scenes-1536';settings.bindings[2].index_name='videoq-prod-scenes-768';settings.bindings[3].text='paused';
 const desired=(await traffic.observe({purpose:'production'})).state.bindingsHash,resumed=await traffic.prepareRestore(paused,desired);settings.bindings[3].text='running';
 let consumerEnabled=true,fenced=true,nativeChanged=false;
 const names=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'];
 const lambda=async(command,input)=>{assert.equal(command,'ListEventSourceMappings');const i=names.indexOf(input.FunctionName);assert.ok(i>=0);return{EventSourceMappings:[{FunctionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+names[i],EventSourceArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+names[i],UUID:`00000000-0000-0000-0000-00000000000${i}`,State:consumerEnabled?'Enabled':'Disabled'}]};};
 const github=async(method,path)=>{assert.equal(method,'GET');const id=Number(path.split('/').at(-1));assert.ok([252628432,403417588].includes(id));return{id,path:id===252628432?'.github/workflows/cd.yml':'.github/workflows/db-maintenance-cd.yml',state:'active'};};
 const consumers=await createConsumerControl(lambda).prepare({purpose:'production'}),deployments=await createDeploymentFreeze(github).prepare();
 const fence={owner:run,fenceTriggers:{first:'sql1',second:'sql2',third:'sql3'}};
 const receipt={run,source,buildArn:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:22222222-2222-2222-2222-222222222222',completedAt:'2026-11-17T00:00:00.000Z',verifyAiAnswers:true};
 const e2e={nativePlan:{},apiVersion:version,apiBindingsSha256:desired};
 const plans=new Map([['pause-api',paused],['resume-api',resumed],['promote-bindings',{sourcePlan:paused,targetBindingsHash:desired}],['pause-consumers',consumers],['freeze-deployments',deployments],['fence-source',fence],['verify-e2e',e2e]]);
 const steps=RESOURCE_STEPS.map(step=>({step,state:'verified',planSha256:resourceDigest(plans.get(step)??{step}),receiptSha256:'d'.repeat(64)}));
 steps.find(row=>row.step==='verify-e2e').receiptSha256=resourceDigest({nativeReceiptSha256:resourceDigest(receipt),apiVersion:version,apiBindingsSha256:desired});
 const state={run,source,revision:25,steps,nextStep:null};
 const verify=createResourceCurrentState({journal:{assertExecutor:async()=>{},inspect:async()=>structuredClone(state)},plans:{load:async name=>structuredClone(plans.get(name))},cloudflare,lambda,github,sourceFence:async()=>({total:3,installed:fenced?Object.keys(fence.fenceTriggers):[]}),targetFence:async()=>({total:3,installed:[]}),smokeProof:{verify:async()=>{const value={...receipt,...(nativeChanged?{completedAt:'2026-11-17T01:00:00.000Z'}:{})};return{receipt:value,receiptSha256:resourceDigest(value)};}},readSmokeBuild:async()=>receipt.buildArn});
 return{verify,state,settings,plans,stopConsumer:()=>consumerEnabled=false,loseFence:()=>fenced=false,changeNative:()=>nativeChanged=true};
}
test('current probes bind actual fixed API/admissions/fences and native proof to journal',async()=>{
 const f=await fixture(),proof=await f.verify(f.state);assert.equal(proof.sourceFenced,true);assert.equal(proof.targetUnfenced,true);assert.equal(proof.databaseId,'587bd210-6d9d-4f32-abb7-a490013e65d3');assert.equal(proof.e2eStepReceiptSha256,f.state.steps.find(row=>row.step==='verify-e2e').receiptSha256);
});
test('drifted API, paused consumer or missing source fence refuses completion',async()=>{
 for(const mutate of [f=>f.settings.bindings[0].id='other',f=>f.stopConsumer(),f=>f.loseFence()]){const f=await fixture();mutate(f);await assert.rejects(f.verify(f.state));}
});
test('changed private plans or different native completion cannot reuse old proof',async()=>{
 const f=await fixture();f.plans.get('resume-api').bindingsHash='e'.repeat(64);await assert.rejects(f.verify(f.state),/PLAN_CHANGED/);
 const g=await fixture();g.changeNative();await assert.rejects(g.verify(g.state),/NATIVE_STEP_CHANGED/);
});
