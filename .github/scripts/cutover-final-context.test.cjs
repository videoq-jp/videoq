const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {assertTransferContext,TARGET}=require('./cutover-final-context.cjs');
const sha=v=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const run='a'.repeat(32),source='b'.repeat(40),capture='c'.repeat(32),arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
 const fenceArn='arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:'+randomUUID(),backupArn='arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-backup-prod:'+randomUUID(),action='d'.repeat(32);
 const original=JSON.stringify({version:1,target:{purpose:'production',host:'ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech',databaseName:'neondb',rolePrefix:'videoq_'}}),fence=JSON.stringify({state:'fenced',writerLogins:2,enabledWriterLogins:0,writerSessions:0,otherDatabaseSessions:0,unknownSessions:0,preparedTransactions:0});
 const consumer={version:1,operationId:randomUUID(),scope:{purpose:'production'},consumers:['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'].map(functionName=>({functionName,functionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+functionName,queueArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+functionName,mappingUuid:randomUUID(),wasEnabled:true}))};
 const deployment={version:1,operationId:randomUUID(),repository:'videoq-jp/videoq',workflows:[{id:252628432,path:'.github/workflows/cd.yml',wasActive:true},{id:403417588,path:'.github/workflows/db-maintenance-cd.yml',wasActive:true}]};
 const backup={version:1,sourceSha:source,runId:capture,buildArn:backupArn,sourceVersion:'synthetic-reviewed-operator-version',manifestVersion:'synthetic-private-version',archiveSha256:'e'.repeat(64),archiveFileSha256Base64:'a'.repeat(43)+'=',archiveBytes:1000,postgresFenceSha256:sha(original)};
 const row={kind:{S:'cutover-hold'},execution_arn:{S:arn},source_sha:{S:source},cutover_phase:{S:'consumers-paused'},cutover_revision:{N:'5'},database_mutations_started:{BOOL:true},release_requested:{BOOL:false},postgres_fence_state:{S:'fenced'},api_pause_verified:{BOOL:true},api_admission_restored:{BOOL:false},deployment_admission_restored:{BOOL:false},consumer_admission_restored:{BOOL:false},postgres_fence_original_plan:{S:original},postgres_fence_original_sha256:{S:sha(original)},postgres_fence_plan_sha256:{S:sha(original)},postgres_fence_receipt:{S:fence},postgres_fence_receipt_sha256:{S:sha(fence)},postgres_fence_build_arn:{S:fenceArn},postgres_fence_action_id:{S:action},consumer_plan:{S:JSON.stringify(consumer)},consumer_plan_sha256:{S:sha(JSON.stringify(consumer))},deployment_freeze_plan:{S:JSON.stringify(deployment)},deployment_freeze_sha256:{S:sha(JSON.stringify(deployment))},final_backup_receipt:{S:JSON.stringify(backup)},final_backup_receipt_sha256:{S:sha(JSON.stringify(backup))}};
 const owner={kind:{S:'cutover-hold'},execution_arn:{S:arn}};
 function native(arn,projectName,values,startTime,endTime){return{arn,projectName,sourceVersion:backup.sourceVersion,buildComplete:true,buildStatus:'SUCCEEDED',startTime,endTime,environment:{environmentVariables:Object.entries(values).map(([name,value])=>({name,value,type:'PLAINTEXT'}))}};}
 const builds=[native(fenceArn,'videoq-db-rotation-prod',{MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_KIND:'cutover-hold',MAINTENANCE_STAGE:'cutover-activity-audit',MAINTENANCE_ACTIVITY_ACTION_ID:action},'2026-11-16T08:00:00Z','2026-11-16T08:01:00Z'),native(backupArn,'videoq-db-backup-prod',{MAINTENANCE_RUN_ID:capture,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_KIND:'backup',MAINTENANCE_STAGE:'backup'},'2026-11-16T08:02:00Z','2026-11-16T08:03:00Z')];
 const settings={bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'},{name:'HYPERDRIVE',type:'hyperdrive',id:'synthetic-hyperdrive'}]};
 let consumerState='Disabled',workflowState='disabled_manually',calls=0;
 const args={run,source,aws:async(service,command,input)=>{
  if(service==='ddb'){assert.equal(command,'GetItem');calls++;return{Item:structuredClone(input.Key.pk.S==='maintenance'?owner:row)};}
  if(service==='codebuild'){assert.equal(command,'BatchGetBuilds');assert.deepEqual(input.ids,[fenceArn,backupArn]);return{builds};}
  assert.equal(service,'lambda');assert.equal(command,'ListEventSourceMappings');const item=consumer.consumers.find(v=>v.functionName===input.FunctionName);return{EventSourceMappings:[{UUID:item.mappingUuid,FunctionArn:item.functionArn,EventSourceArn:item.queueArn,State:consumerState}]};
 },github:async(method,path)=>{assert.equal(method,'GET');const item=deployment.workflows.find(v=>path.includes('/'+v.id));assert.ok(item);return path.includes('/runs?')?{total_count:0,workflow_runs:[]}:{id:item.id,path:item.path,state:workflowState};},cloudflare:async()=>settings,fetcher:async url=>url.endsWith('/health')?Response.json({data:{status:'ok'}}):Response.json({error:{code:'MIGRATION_PAUSED'}},{status:503,headers:{'retry-after':'60','cache-control':'no-store'}})};
 return{args,row,owner,builds,settings,backup,changeBackup(fn){fn(backup);row.final_backup_receipt={S:JSON.stringify(backup)};row.final_backup_receipt_sha256={S:sha(JSON.stringify(backup))};},enableConsumer(){consumerState='Enabled';},enableWorkflow(){workflowState='active';},get calls(){return calls;}};
}
test('native fenced backup, ownership and all real-admission transports must agree',async()=>{
 const f=fixture();const result=await assertTransferContext(f.args);assert.equal(result.backup.archiveSha256,'e'.repeat(64));assert.equal(result.target.databaseId,TARGET.databaseId);assert.equal(f.calls,4);
});
test('a backup captured before the fence, stale source or incomplete native build is rejected',async()=>{
 for(const change of [f=>{f.builds[1].startTime='2026-11-16T07:59:00Z';},f=>{f.builds[1].sourceVersion='other';},f=>{f.builds[1].buildComplete=false;},f=>{f.builds[0].environment.environmentVariables.find(v=>v.name==='MAINTENANCE_SOURCE_SHA').value='f'.repeat(40);}]){const f=fixture();change(f);await assert.rejects(()=>assertTransferContext(f.args));}
});
test('marker reset, owner loss, reopened API/consumers/deployments and changed proof refuse transfer',async()=>{
 for(const change of [f=>{f.row.database_mutations_started.BOOL=false;},f=>{f.owner.execution_arn.S+='other';},f=>{f.settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text='running';},f=>f.enableConsumer(),f=>f.enableWorkflow(),f=>{f.row.final_backup_receipt.S+=' ';}]){const f=fixture();change(f);await assert.rejects(()=>assertTransferContext(f.args));}
});
test('an active D1 backend cannot be imported through the forward offline-candidate path',async()=>{
 const f=fixture();f.settings.bindings.push({name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'DB',type:'d1',id:TARGET.databaseId},...[1536,768].map(n=>({name:'SCENE_VECTORIZE_'+n,type:'vectorize',index_name:'synthetic-'+n})));await assert.rejects(()=>assertTransferContext(f.args),/CUTOVER_API_BACKEND_OR_PAUSE_CHANGED/);
});
