const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceCompletion}=require('./d1-resource-completion.cjs');
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const run='a'.repeat(32),source='b'.repeat(40),token='c'.repeat(64),hash='d'.repeat(64);
function current(){return{apiAdmissionRestored:true,consumerAdmissionRestored:true,deploymentAdmissionRestored:true,sourceFenced:true,targetUnfenced:true,
 accountId:'12daec56fdba43f677f2766ee26a5a39',databaseId:'587bd210-6d9d-4f32-abb7-a490013e65d3',largeIndex:'videoq-prod-scenes-1536',smallIndex:'videoq-prod-scenes-768',apiVersion:'11111111-1111-1111-1111-111111111111',smokeBuildArn:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:22222222-2222-2222-2222-222222222222',smokeSourceSha:source,smokeCompletedAt:'2026-11-17T00:00:00.000Z',e2eStepReceiptSha256:hash};}
function fixture(){
 const steps=RESOURCE_STEPS.map(step=>({step,state:'verified',operationId:'33333333-3333-3333-3333-333333333333',planSha256:hash,receiptSha256:hash}));
 const state={run,source,steps,revision:25,nextStep:null},row={execution_arn:{S:'arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run},kind:{S:'d1-resource-hold'},source_sha:{S:source},resource_executor_sha256:{S:resourceDigest({executorToken:token})},resource_phase:{S:'holding'},release_requested:{BOOL:false},resource_revision:{N:'25'},resource_steps:{S:JSON.stringify(steps)},resource_steps_sha256:{S:resourceDigest(steps)}};
 let calls=0,lost=false,race=false,owned=true,probe=current();
 const aws=async(_service,command,input)=>{
  if(command==='GetItem')return{Item:structuredClone(row)};
  assert.equal(command,'TransactWriteItems');calls++;if(race)throw Error('CAS_FAILED');
  const values=input.TransactItems[0].Update.ExpressionAttributeValues;
  Object.assign(row,{resource_phase:values[':verified'],release_requested:values[':true'],resource_revision:values[':next'],resource_completion_receipt:values[':receipt'],resource_completion_receipt_sha256:values[':receiptSha'],api_admission_restored:values[':true'],consumer_admission_restored:values[':true'],deployment_admission_restored:values[':true']});
  if(lost){lost=false;throw Error('LOST_RESPONSE');}return{};
 };
 const options={aws,journal:{assertExecutor:async()=>{if(!owned)throw Error('RESOURCE_OWNER_LOST');},inspect:async()=>structuredClone(state)},run,source,executorToken:token,verifyCurrentState:async()=>probe,enabled:true};
 return{row,state,options,completion:createResourceCompletion(options),calls:()=>calls,probe:value=>probe=value,lose:()=>lost=true,race:()=>race=true,revoke:()=>owned=false};
}
test('completion refuses disabled execution, missing steps and unverified native E2E',async()=>{
 const f=fixture();await assert.rejects(createResourceCompletion({...f.options,enabled:false}).request(),/DISABLED/);f.state.steps.pop();await assert.rejects(f.completion.request(),/ALL_STEPS/);assert.equal(f.calls(),0);
 const g=fixture();g.probe({...current(),e2eStepReceiptSha256:'e'.repeat(64)});await assert.rejects(g.completion.request(),/CURRENT_PROOF/);assert.equal(g.calls(),0);
});
test('each admission, source fence, target binding and pinned smoke source must match',async()=>{
 for(const change of [{apiAdmissionRestored:false},{consumerAdmissionRestored:false},{deploymentAdmissionRestored:false},{sourceFenced:false},{targetUnfenced:false},{databaseId:'other'},{smokeSourceSha:'e'.repeat(40)}]){const f=fixture();f.probe({...current(),...change});await assert.rejects(f.completion.request(),/CURRENT_PROOF/);assert.equal(f.calls(),0);}
});
test('verified completion persists before release and reconciles a lost write response',async()=>{
 const f=fixture();f.lose();const result=await f.completion.request();assert.equal(result.releaseRequested,true);assert.equal(f.row.resource_phase.S,'verified');assert.equal(f.row.resource_revision.N,'26');assert.deepEqual(await f.completion.request(),result);assert.equal(f.calls(),1);
});
test('ownership loss or a conditional conflict cannot set release markers',async()=>{
 const f=fixture();f.revoke();await assert.rejects(f.completion.request(),/OWNER_LOST/);assert.equal(f.calls(),0);
 const g=fixture();g.race();await assert.rejects(g.completion.request(),/WRITE_UNCERTAIN/);assert.equal(g.row.release_requested.BOOL,false);
});
test('altered durable completion receipts refuse success on reentry',async()=>{
 const f=fixture();await f.completion.request();f.row.resource_completion_receipt_sha256={S:'f'.repeat(64)};await assert.rejects(f.completion.request(),/RECORD_INVALID/);
});
