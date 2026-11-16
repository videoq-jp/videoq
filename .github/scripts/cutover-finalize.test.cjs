'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {createFinalizer,validateCanonicalD1}=require('./cutover-finalize.cjs');
const {apiFingerprint}=require('./cutover-backend-handoff.cjs');
const {TARGET}=require('./cutover-final-context.cjs');
const sha=v=>createHash('sha256').update(v).digest('hex');
const objectHash=v=>sha(JSON.stringify(v));
function fixture(options={}){
 const run='a'.repeat(32),source='b'.repeat(40),version=randomUUID(),smokeRunId='c'.repeat(32),smokeBuildArn='arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:'+randomUUID();
 const row={kind:{S:'cutover-hold'},backend_handoff_intent:{S:'synthetic-owned-intent'},execution_arn:{S:'arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run},source_sha:{S:source},cutover_revision:{N:'5'},cutover_phase:{S:'consumers-paused'},database_mutations_started:{BOOL:true},release_requested:{BOOL:false},api_admission_restored:{BOOL:false},consumer_admission_restored:{BOOL:false},deployment_admission_restored:{BOOL:false}};
 const settings={bindings:[{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'},{name:'DB',type:'d1',id:TARGET.databaseId},{name:'BETTER_AUTH_SECRET',type:'secret_text'}]};
 const profiles=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'].map(name=>({FunctionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+name,RevisionId:randomUUID(),CodeSha256:'reviewed-code',State:'Active',LastUpdateStatus:'Successful',Environment:{Variables:{PERSISTENCE_BACKEND:'d1'}}}));
 const receipt={version:1,runId:run,sourceSha:source,target:TARGET,apiVersion:version,apiBindingsSha256:apiFingerprint(settings),profiles:profiles.map((p,i)=>({name:['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'][i],revision:p.RevisionId,codeSha256:p.CodeSha256,environmentSha256:objectHash(p.Environment.Variables)})),admissionPaused:true,productionSafe:false};
 row.backend_handoff_receipt={S:JSON.stringify(receipt)};row.backend_handoff_receipt_sha256={S:sha(JSON.stringify(receipt))};
 const consumer={consumers:profiles.map(p=>({functionName:p.FunctionArn.split(':').at(-1),functionArn:p.FunctionArn,queueArn:p.FunctionArn.replace(':lambda:',':sqs:').replace(':function:',':'),mappingUuid:randomUUID(),wasEnabled:true})),version:1,scope:{purpose:'production'},operationId:randomUUID()};
 const deployment={version:1,operationId:randomUUID(),repository:'videoq-jp/videoq',workflows:[{id:252628432,path:'.github/workflows/cd.yml',wasActive:true},{id:403417588,path:'.github/workflows/db-maintenance-cd.yml',wasActive:true}]};
 row.consumer_plan={S:JSON.stringify(consumer)};row.consumer_plan_sha256={S:sha(JSON.stringify(consumer))};row.deployment_freeze_plan={S:JSON.stringify(deployment)};row.deployment_freeze_sha256={S:sha(JSON.stringify(deployment))};
 const states=new Map(consumer.consumers.map(v=>[v.functionName,'Disabled'])),workflowStates=new Map(deployment.workflows.map(v=>[v.id,'disabled_manually']));
 let owned=true,canonical=true,apiWrites=0,mappingWrites=0,workflowWrites=0;
 const native={arn:smokeBuildArn,projectName:'videoq-db-smoke-prod',buildStatus:'SUCCEEDED',buildComplete:true,sourceVersion:'reviewed-native-source',startTime:'2026-11-16T10:10:00Z',endTime:'2026-11-16T10:15:00Z',environment:{environmentVariables:Object.entries({MAINTENANCE_RUN_ID:smokeRunId,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_STAGE:'smoke',MAINTENANCE_KIND:'smoke',VERIFY_AI_ANSWERS:'true',VIDEOQ_D1_PRODUCTION_SMOKE:'true'}).map(([name,value])=>({name,value,type:'PLAINTEXT'}))}};
 const args={run,source,now:()=> '2026-11-16T10:00:00Z',sleep:async()=>{},verifyCanonical:async()=>{if(!canonical)throw Error('SYNTHETIC_CANONICAL_CONFIG_NOT_READY');},verifyContext:async({expectedTraffic,expectedConsumers,expectedDeployments})=>{
  if(!owned||row.cutover_phase.S!=='consumers-paused'||!row.database_mutations_started.BOOL||row.release_requested.BOOL)throw Error('SYNTHETIC_OWNER_LOSS');assert.equal(settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text,expectedTraffic);
  if(expectedConsumers==='paused')assert.ok([...states.values()].every(v=>v==='Disabled'));if(expectedConsumers==='original')assert.ok([...states.values()].every(v=>v==='Enabled'));
  if(expectedDeployments==='frozen')assert.ok([...workflowStates.values()].every(v=>v==='disabled_manually'));if(expectedDeployments==='original')assert.ok([...workflowStates.values()].every(v=>v==='active'));
  return{row:structuredClone(row),settings:structuredClone(settings),consumer,deployment,backup:{sourceVersion:'reviewed-native-source'}};
 },aws:async(service,command,input)=>{
  if(service==='ddb'){
   if(command==='GetItem')return{Item:structuredClone(row)};assert.equal(command,'TransactWriteItems');assert.ok(owned);assert.equal(input.TransactItems.length,2);const update=input.TransactItems[0].Update,v=update.ExpressionAttributeValues,n=update.ExpressionAttributeNames;
   assert.match(update.ConditionExpression,/database_mutations_started=:true/);assert.equal(v[':previous'].N,row.cutover_revision.N);
   for(const assignment of update.UpdateExpression.replace(/^SET /,'').split(',')){const [key,value]=assignment.split('=');row[n[key]??key]=structuredClone(v[value]);}
   if(options.lostRecordResponse)throw Error('SYNTHETIC_LOST_RESPONSE');return{};
  }
  if(service==='scheduler')return{State:options.scheduleEnabled?'ENABLED':'DISABLED',Arn:'arn:aws:scheduler:ap-northeast-1:257240362763:schedule/default/videoq-db-maintenance-prod'};
  if(service==='codebuild')return{builds:[native]};
  assert.equal(service,'lambda');if(command==='GetFunctionConfiguration')return structuredClone(profiles.find(p=>p.FunctionArn.endsWith(':'+input.FunctionName)));
  if(command==='ListEventSourceMappings'){const item=consumer.consumers.find(v=>v.functionName===input.FunctionName);return{EventSourceMappings:[{UUID:item.mappingUuid,FunctionArn:item.functionArn,EventSourceArn:item.queueArn,State:states.get(item.functionName)}]};}
  assert.equal(command,'UpdateEventSourceMapping');assert.ok(row.d1_resume_intent);assert.equal(settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text,input.Enabled?'running':'paused');const item=consumer.consumers.find(v=>v.mappingUuid===input.UUID);states.set(item.functionName,input.Enabled?'Enabled':'Disabled');mappingWrites++;return{};
 },cloudflare:async(method,path,input)=>{
  if(path.endsWith('/deployments'))return{deployments:[{versions:[{version_id:version,percentage:100}]}]};if(path.includes('/versions?'))return{items:[{id:version}]};
  if(method==='GET')return structuredClone(settings);assert.ok(row.d1_resume_intent);if(input.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text==='running')assert.equal(mappingWrites,0);else assert.ok(row.d1_emergency_stop_intent);apiWrites++;const previous=settings.bindings;settings.bindings=input.bindings.map(v=>v.type==='inherit'?previous.find(p=>p.name===v.name):v);return{};
 },github:async(method,path)=>{const fixed=deployment.workflows.find(v=>path.includes('/'+v.id));assert.ok(fixed);if(method==='PUT'){if(path.endsWith('/enable'))assert.ok(row.d1_e2e_receipt);else assert.ok(row.d1_emergency_stop_intent);workflowStates.set(fixed.id,path.endsWith('/enable')?'active':'disabled_manually');workflowWrites++;if(options.lostWorkflowResponse&&workflowWrites===1)throw Error('SYNTHETIC_LOST_WORKFLOW_RESPONSE');return null;}return path.includes('/runs?')?{total_count:0,workflow_runs:[]}:{id:fixed.id,path:fixed.path,state:workflowStates.get(fixed.id)};},fetcher:async url=>settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text==='paused'&&!url.endsWith('/health')?Response.json({error:{code:'MIGRATION_PAUSED'}},{status:503,headers:{'retry-after':'60','cache-control':'no-store'}}):Response.json({data:{status:'ready',db:'ok'}})};
 return{args,row,native,profiles,settings,smokeBuildArn,smokeRunId,get apiWrites(){return apiWrites;},get mappingWrites(){return mappingWrites;},get workflowWrites(){return workflowWrites;},loseOwner(){owned=false;},badCanonical(){canonical=false;}};
}
test('D1 admission resumes only after durable intent and completion waits for native AI E2E before deployment restore',async()=>{
 const f=fixture(),control=createFinalizer(f.args);await control.resume();assert.equal(f.apiWrites,1);assert.equal(f.mappingWrites,3);assert.equal(f.workflowWrites,0);assert.equal(f.row.release_requested.BOOL,false);await control.resume();assert.equal(f.apiWrites,1);
 await control.complete(f);assert.equal(f.workflowWrites,2);assert.equal(f.row.cutover_phase.S,'postwrite-complete');assert.equal(f.row.release_requested.BOOL,true);assert.equal(f.row.database_mutations_started.BOOL,true);assert.equal(f.row.api_pause_verified.BOOL,false);
});
test('native failed, wrong-source, pre-resume and non-AI builds cannot restore deployments or request release',async()=>{
 for(const change of [f=>{f.native.buildStatus='FAILED';},f=>{f.native.sourceVersion='unreviewed';},f=>{f.native.startTime='2026-11-16T09:00:00Z';},f=>{f.native.environment.environmentVariables.find(v=>v.name==='VERIFY_AI_ANSWERS').value='false';}]){const f=fixture(),control=createFinalizer(f.args);await control.resume();change(f);await assert.rejects(()=>control.complete(f));assert.equal(f.workflowWrites,0);assert.equal(f.row.release_requested.BOOL,false);}
});
test('changed workers, enabled Neon rotation, missing canonical config or lost owner never reopen admission',async()=>{
 for(const change of [f=>{f.profiles[0].RevisionId=randomUUID();},f=>f.badCanonical(),f=>f.loseOwner()]){const f=fixture();change(f);await assert.rejects(()=>createFinalizer(f.args).resume());assert.equal(f.apiWrites,0);assert.equal(f.mappingWrites,0);}
 const f=fixture({scheduleEnabled:true});await assert.rejects(()=>createFinalizer(f.args).resume());assert.equal(f.apiWrites,0);
});
test('lost successful records reconcile, and partial deployment restoration is safely retryable',async()=>{
 const f=fixture({lostRecordResponse:true,lostWorkflowResponse:true}),control=createFinalizer(f.args);await control.resume();await assert.rejects(()=>control.complete(f));assert.equal(f.row.release_requested.BOOL,false);await control.complete(f);assert.equal(f.row.release_requested.BOOL,true);assert.equal(f.row.database_mutations_started.BOOL,true);
});
test('canonical main must name the fixed D1/vector targets without cloud PostgreSQL fallback',()=>{
 const good={env:{production:{name:'videoq-api',vars:{DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1'},d1_databases:[{binding:'DB',database_id:TARGET.databaseId}],vectorize:[{binding:'SCENE_VECTORIZE_1536',index_name:TARGET.largeIndex},{binding:'SCENE_VECTORIZE_768',index_name:TARGET.smallIndex}]}}};assert.equal(validateCanonicalD1(good),true);assert.throws(()=>validateCanonicalD1({...good,env:{production:{...good.env.production,hyperdrive:[{binding:'HYPERDRIVE'}]}}}));
});
test('owned emergency stop closes D1 admission and preserves all fences without claiming in-flight drain',async()=>{
 const f=fixture(),control=createFinalizer(f.args);await control.resume();const receipt=await control.stop();assert.deepEqual(receipt,{admissionPaused:true,inFlightDrainProven:false,productionSafe:false});assert.equal(f.settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text,'paused');assert.equal(f.mappingWrites,6);assert.equal(f.row.database_mutations_started.BOOL,true);assert.equal(f.row.release_requested.BOOL,false);assert.ok(f.row.d1_emergency_stop_receipt);
});
test('ASL postwrite release requires preserved write marker, PG fence and restored admission with E2E receipts',()=>{
 const {definition}=require('../../infra/db-maintenance/state-machine.cjs');const states=definition({table:'synthetic',projects:{}}).States,release=states.ReleasePostwriteHold.Parameters.TransactItems;
 assert.equal(states.ReleasePostwriteHold.Next,'Success');assert.match(release[0].ConditionCheck.ConditionExpression,/database_mutations_started = :true/);assert.match(release[0].ConditionCheck.ConditionExpression,/postgres_fence_state = :fenced/);assert.match(release[0].ConditionCheck.ConditionExpression,/attribute_exists\(d1_e2e_receipt\)/);assert.equal(release[1].Delete.ExpressionAttributeValues[':kind'].S,'cutover-hold');assert.match(states.ReleaseCutoverHold.Parameters.TransactItems[0].ConditionCheck.ConditionExpression,/database_mutations_started = :false/);
});
test('finalizer CLI rejects malformed operations and GitHub environments before AWS access',async()=>{
 const {parse,main}=require('./run-cutover-finalize.cjs');assert.throws(()=>parse(['--action','complete','--run','a'.repeat(32),'--source','b'.repeat(40)]));assert.throws(()=>parse(['--action','resume','--run','a'.repeat(32),'--run','b'.repeat(40)]));let calls=0;await assert.rejects(()=>main({args:['--action','resume','--run','a'.repeat(32),'--source','b'.repeat(40)],env:{GITHUB_ACTIONS:'true'},verifySource:async()=>{calls++;},aws:async()=>{calls++;}}));assert.equal(calls,0);
});
