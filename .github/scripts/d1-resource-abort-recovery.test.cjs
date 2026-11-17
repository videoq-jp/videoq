const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceAbortRecovery}=require('./d1-resource-abort-recovery.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
const {createConsumerControl}=require('./cutover-sqs-consumers.cjs');
const {createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
const {resourceDigest,RESOURCE_STEPS}=require('./d1-resource-journal.cjs');
const run='a'.repeat(32),source='b'.repeat(40),executorToken='c'.repeat(64),execution='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
async function fixture({early=false,originalDisabled=false,lostWrite=false}={}){
 const version='11111111-1111-1111-1111-111111111111',calls=[];let owned=true,fenced=!early,consumerEnabled=!originalDisabled,workflowActive=!originalDisabled;
 const settings={compatibility_date:'2026-08-20',bindings:[{name:'DB',type:'d1',id:'e57d0931-18cb-4f00-ae7f-b0068030fb04'},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:'videoq-scenes-migration-v3-1536'},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:'videoq-scenes-migration-v3-768'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'running'}]};
 const cloudflare=async(method,path,value)=>{if(method==='PATCH'){calls.push('api');settings.bindings[3].text=value.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text;return{};}assert.equal(method,'GET');if(path.endsWith('/deployments'))return{deployments:[{id:version,versions:[{version_id:version,percentage:100}]}]};if(path.endsWith('/versions?per_page=1'))return{items:[{id:version}]};return structuredClone(settings);};
 const names=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'];
 const lambda=async(command,input)=>{if(command==='UpdateEventSourceMapping'){assert.equal(settings.bindings[3].text,'running');assert.equal(fenced,false);consumerEnabled=input.Enabled;calls.push('consumer');return{};}const i=names.indexOf(input.FunctionName);return{EventSourceMappings:[{FunctionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+names[i],EventSourceArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+names[i],UUID:`00000000-0000-0000-0000-00000000000${i}`,State:consumerEnabled?'Enabled':'Disabled'}]};};
 const github=async(method,path)=>{if(method==='PUT'){assert.equal(fenced,false);assert.equal(settings.bindings[3].text,'running');workflowActive=true;calls.push('deployment');return{};}const id=Number(path.split('/').at(-1));return{id,path:id===252628432?'.github/workflows/cd.yml':'.github/workflows/db-maintenance-cd.yml',state:workflowActive?'active':'disabled_manually'};};
 const pauseApi=await createApiTrafficControl(cloudflare).prepare({purpose:'production'}),pauseConsumers=await createConsumerControl(lambda).prepare({purpose:'production'}),freeze=await createDeploymentFreeze(github).prepare(),fence={owner:run,fenceTriggers:{owned:'sql'}};
 const plans=new Map([['freeze-deployments',freeze],['pause-api',pauseApi],['pause-consumers',pauseConsumers],['fence-source',fence]]);
 const state={run,source,revision:10,steps:early?[]:RESOURCE_STEPS.slice(0,4).map(step=>({step,state:step==='fence-source'?'intent':'verified',planSha256:resourceDigest(plans.get(step))}))};
 let row={execution_arn:{S:execution},kind:{S:'d1-resource-hold'},source_sha:{S:source},resource_executor_sha256:{S:resourceDigest({executorToken})},resource_phase:{S:'holding'},release_requested:{BOOL:false},resource_abort_requested:{BOOL:true}};
 if(!early){settings.bindings[3].text='paused';consumerEnabled=false;workflowActive=false;}
 const journal={requestAbort:async()=>{calls.push('abort');},assertAbortExecutor:async()=>{if(!owned)throw Error('RESOURCE_ABORT_OWNER_LOST');return structuredClone(state);}};
 const aws=async(service,command,input)=>{assert.equal(service,'ddb');if(command==='GetItem')return{Item:structuredClone(row)};assert.equal(command,'TransactWriteItems');const update=input.TransactItems[0].Update,v=update.ExpressionAttributeValues;assert.match(update.ConditionExpression,/resource_abort_requested=:true/);assert.equal(v[':previous'].N,String(state.revision));calls.push('completion');row={...row,resource_revision:v[':next'],resource_phase:v[':aborted'],release_requested:v[':true'],resource_steps:v[':steps'],resource_steps_sha256:v[':stepsSha'],resource_completion_receipt:v[':receipt'],resource_completion_receipt_sha256:v[':receiptSha'],api_admission_restored:v[':true'],consumer_admission_restored:v[':true'],deployment_admission_restored:v[':true']};if(lostWrite){lostWrite=false;throw Error('private body');}return{};};
 const sourceFence={inspect:async()=>({installed:fenced?['owned']:[],total:1}),remove:async()=>{assert.equal(settings.bindings[3].text,'paused');assert.equal(consumerEnabled,false);assert.equal(workflowActive,false);calls.push('unfence');fenced=false;},assertUnfenced:async()=>{if(fenced)throw Error('RESOURCE_ABORT_SOURCE_STILL_FENCED');return resourceDigest({unfenced:true});}};
 const options={aws,journal,plans:{load:async name=>structuredClone(plans.get(name))},cloudflare,lambda,github,sourceFence,run,source,executorToken,enabled:true};
 return{recovery:createResourceAbortRecovery(options),options,calls,plans,settings,state,get row(){return row;},loseOwner:()=>owned=false};
}
test('abort restores source before API, consumers and deployments, then persists conditional release receipt',async()=>{
 const f=await fixture();const stages=[];for(let i=0;i<5;i++)stages.push(await f.recovery.advance());assert.deepEqual(stages.slice(0,4).map(v=>v.restored),['source-fence','api','consumers','deployments']);assert.equal(stages[4].status,'abort-release-requested');assert.equal(f.row.resource_phase.S,'aborted');assert.equal(f.row.release_requested.BOOL,true);assert.equal(f.calls.filter(v=>v==='unfence').length,1);
 const count=f.calls.length;assert.deepEqual(await f.recovery.advance(),stages[4]);assert.equal(f.calls.length,count);
});
test('early abort has no planned admission mutations and reconciles a lost completion write response',async()=>{
 const f=await fixture({early:true,lostWrite:true});assert.equal((await f.recovery.advance()).status,'abort-release-requested');assert.deepEqual(f.calls,['abort','completion']);
});
test('original disabled admissions remain disabled',async()=>{
 const f=await fixture({originalDisabled:true});for(let i=0;i<3;i++)await f.recovery.advance();assert.equal(f.row.resource_phase.S,'aborted');assert.equal(f.calls.includes('consumer'),false);assert.equal(f.calls.includes('deployment'),false);
});
test('changed plan, target binding or abort ownership prevents restoration and release',async()=>{
 for(const mutate of [f=>f.plans.get('pause-api').settingsHash='d'.repeat(64),f=>f.settings.bindings[0].id='587bd210-6d9d-4f32-abb7-a490013e65d3',f=>f.loseOwner()]){const f=await fixture();mutate(f);await assert.rejects(f.recovery.advance());assert.equal(f.calls.includes('unfence'),false);assert.equal(f.calls.includes('completion'),false);}
});
test('recovery defaults disabled before any read and never releases a hold directly',async()=>{
 const f=await fixture();await assert.rejects(createResourceAbortRecovery({...f.options,enabled:false,aws:async()=>assert.fail('AWS called')}).advance(),/DISABLED/);assert.equal(f.row.resource_phase.S,'holding');
});

test('provider response bodies are excluded from recovery errors',async()=>{
 const f=await fixture();const recovery=createResourceAbortRecovery({...f.options,aws:async()=>{throw Error('PRIVATE_PROVIDER_BODY');}});await assert.rejects(recovery.advance(),{message:'RESOURCE_ABORT_RECOVERY_FAILED'});
});
