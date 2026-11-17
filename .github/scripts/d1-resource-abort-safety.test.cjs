const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceAbortSourceSafety}=require('./d1-resource-abort-safety.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
const {createConsumerControl}=require('./cutover-sqs-consumers.cjs');
const {createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
async function fixture(){
 const run='a'.repeat(32),version='11111111-1111-1111-1111-111111111111';let owned=true,workersStopped=true,consumerState='Enabled',workflowState='active',activeRuns=false;
 const settings={compatibility_date:'2026-08-20',bindings:[{name:'DB',type:'d1',id:'e57d0931-18cb-4f00-ae7f-b0068030fb04'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'running'}]};
 const cloudflare=async(method,path)=>{assert.equal(method,'GET');if(path.endsWith('/deployments'))return{deployments:[{id:version,versions:[{version_id:version,percentage:100}]}]};if(path.endsWith('/versions?per_page=1'))return{items:[{id:version}]};return structuredClone(settings);};
 const names=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'];
 const lambda=async(command,input)=>{assert.equal(command,'ListEventSourceMappings');const i=names.indexOf(input.FunctionName);return{EventSourceMappings:[{FunctionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+names[i],EventSourceArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+names[i],UUID:`00000000-0000-0000-0000-00000000000${i}`,State:consumerState}]};};
 const github=async(method,path)=>{assert.equal(method,'GET');if(path.includes('/runs?'))return{total_count:activeRuns?1:0,workflow_runs:activeRuns?[{id:1,workflow_id:Number(path.split('/').at(-2)),status:'in_progress'}]:[]};const id=Number(path.split('/').at(-1));return{id,path:id===252628432?'.github/workflows/cd.yml':'.github/workflows/db-maintenance-cd.yml',state:workflowState};};
 const fence={owner:run,fenceTriggers:{name:'sql'}},paused=await createApiTrafficControl(cloudflare).prepare({purpose:'production'}),consumers=await createConsumerControl(lambda).prepare({purpose:'production'}),deployments=await createDeploymentFreeze(github).prepare();
 settings.bindings[1].text='paused';consumerState='Disabled';workflowState='disabled_manually';
 const plans=new Map([['fence-source',fence],['pause-api',paused],['pause-consumers',consumers],['freeze-deployments',deployments]]),steps=[...plans].map(([step,value])=>({step,state:step==='fence-source'?'intent':'verified',planSha256:resourceDigest(value)}));
 const safe=createResourceAbortSourceSafety({journal:{assertAbortExecutor:async()=>{if(!owned)throw Error('RESOURCE_ABORT_OWNERSHIP_LOST');return{run,steps};}},plans:{load:async name=>structuredClone(plans.get(name))},cloudflare,lambda,github,assertRecoveryIsolation:async()=>{if(!workersStopped)throw Error('RESOURCE_ABORT_WORKERS_ACTIVE');}});
 return{safe,fence,settings,plans,loseOwner:()=>owned=false,activateWorker:()=>workersStopped=false,enableConsumer:()=>consumerState='Enabled',enableWorkflow:()=>workflowState='active',startRun:()=>activeRuns=true};
}
test('abort source safety verifies original paused API, stopped consumers and drained frozen deployments',async()=>{const f=await fixture();await f.safe({plan:f.fence});});
test('source safety refuses active admission, accepted deploy, active worker or lost abort ownership',async()=>{
 for(const mutate of [f=>f.settings.bindings[1].text='running',f=>f.enableConsumer(),f=>f.enableWorkflow(),f=>f.startRun(),f=>f.activateWorker(),f=>f.loseOwner()]){const f=await fixture();mutate(f);await assert.rejects(f.safe({plan:f.fence}));}
});
test('source safety rejects target database binding or changed original private plan',async()=>{
 const f=await fixture();f.settings.bindings[0].id='587bd210-6d9d-4f32-abb7-a490013e65d3';await assert.rejects(f.safe({plan:f.fence}),/NOT_ISOLATED/);
 const g=await fixture();g.plans.get('pause-api').bindingsHash='b'.repeat(64);await assert.rejects(g.safe({plan:g.fence}),/ORIGINAL_PLANS/);
});
