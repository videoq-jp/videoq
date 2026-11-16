// Controlled D1 admission resume and native-E2E-bound completion. This never
// clears the database-write marker or re-enables PostgreSQL writer logins.
'use strict';
const {createHash}=require('node:crypto');
const {assertTransferContext,TARGET,TABLE}=require('./cutover-final-context.cjs');
const {apiFingerprint}=require('./cutover-backend-handoff.cjs');
const {createConsumerControl,validateConsumerPlan}=require('./cutover-sqs-consumers.cjs');
const {createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
const {verifyProductionTraffic}=require('./cutover-owned-api-traffic.cjs');
const hash=v=>createHash('sha256').update(v).digest('hex');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,stable(value)])):v;
const objectHash=v=>hash(JSON.stringify(stable(v)));
const base='accounts/'+TARGET.accountId+'/workers/scripts/videoq-api';
function bound(row,key,shaKey=key+'_sha256'){const text=row[key]?.S;if(typeof text!=='string'||hash(text)!==row[shaKey]?.S)throw Error('FINAL_HANDOFF_RECORD_CHANGED');return JSON.parse(text);}
function validateCanonicalD1(config){
 const p=config?.env?.production;if(p?.name!=='videoq-api'||p.vars?.DEPLOYMENT_EDITION!=='cloud'||p.vars?.PERSISTENCE_BACKEND!=='d1'||p.vars?.MIGRATION_ALLOW_CLOUD_POSTGRES!==undefined||(p.hyperdrive??[]).length||p.d1_databases?.length!==1||p.d1_databases[0].binding!=='DB'||p.d1_databases[0].database_id!==TARGET.databaseId)throw Error('CANONICAL_D1_CONFIGURATION_REQUIRED');
 for(const [binding,name]of [['SCENE_VECTORIZE_1536',TARGET.largeIndex],['SCENE_VECTORIZE_768',TARGET.smallIndex]])if(p.vectorize?.filter(v=>v.binding===binding&&v.index_name===name).length!==1)throw Error('CANONICAL_D1_CONFIGURATION_REQUIRED');return true;
}
function createFinalizer({run,source,aws,github,cloudflare,verifyCanonical,fetcher=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>new Date().toISOString(),verifyContext=assertTransferContext}){
 const get=pk=>aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:pk}},ConsistentRead:true});
 async function observed({traffic='running',consumers='original',deployments='frozen'}={}){
  await verifyCanonical();
  const context=await verifyContext({run,source,aws,github,cloudflare,fetcher,expectedBackend:'d1',expectedTraffic:traffic,expectedConsumers:consumers,expectedDeployments:deployments});
  const receipt=bound(context.row,'backend_handoff_receipt');if(receipt.version!==1||receipt.runId!==run||receipt.sourceSha!==source||objectHash(receipt.target)!==objectHash(TARGET)||receipt.admissionPaused!==true||receipt.productionSafe!==false||!Array.isArray(receipt.profiles)||receipt.profiles.length!==3)throw Error('VERIFIED_D1_HANDOFF_REQUIRED');
  const expectedNames=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'];
  for(let i=0;i<3;i++){
   const item=receipt.profiles[i];if(item.name!==expectedNames[i])throw Error('FIXED_D1_WORKER_PROFILES_REQUIRED');
   const value=await aws('lambda','GetFunctionConfiguration',{FunctionName:item.name});
   if(value.FunctionArn!=='arn:aws:lambda:ap-northeast-1:257240362763:function:'+item.name||value.RevisionId!==item.revision||value.CodeSha256!==item.codeSha256||value.State!=='Active'||value.LastUpdateStatus!=='Successful'||objectHash(value.Environment?.Variables)!==item.environmentSha256)throw Error('D1_WORKER_PROFILE_CHANGED');
  }
  const scheduler=await aws('scheduler','GetSchedule',{Name:'videoq-db-maintenance-prod',GroupName:'default'});if(scheduler.State!=='DISABLED'||scheduler.Arn!=='arn:aws:scheduler:ap-northeast-1:257240362763:schedule/default/videoq-db-maintenance-prod')throw Error('NEON_ROTATION_MUST_STAY_DISABLED');
  const deployment=await cloudflare('GET',base+'/deployments'),latest=await cloudflare('GET',base+'/versions?per_page=1'),active=deployment.deployments?.[0];
  if(active?.versions?.length!==1||active.versions[0].percentage!==100||active.versions[0].version_id!==latest.items?.[0]?.id||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(active.versions[0].version_id??''))throw Error('STABLE_D1_VERSION_REQUIRED');
  const version=active.versions[0].version_id;
  if(traffic==='paused'&&!context.row.d1_resume_intent){if(version!==receipt.apiVersion||apiFingerprint(context.settings)!==receipt.apiBindingsSha256)throw Error('D1_BACKEND_CHANGED_BEFORE_RESUME');}
  else if(context.row.d1_resume_receipt){const resumed=bound(context.row,'d1_resume_receipt');if(version!==resumed.apiVersion||apiFingerprint(context.settings)!==resumed.apiBindingsSha256)throw Error('D1_BACKEND_CHANGED_AFTER_RESUME');}
  else if(context.row.d1_resume_intent){const intent=bound(context.row,'d1_resume_intent');if(apiFingerprint(context.settings)!==(traffic==='paused'?receipt.apiBindingsSha256:intent.apiBindingsSha256))throw Error('D1_RESUME_CONFIGURATION_CHANGED');}
  return{...context,handoff:receipt,apiVersion:version};
 }
 async function record(context,field,value,complete=false){
  const row=context.row,text=JSON.stringify(value),sha=hash(text),next=String(Number(row.cutover_revision.N)+1),values={':execution':row.execution_arn,':source':row.source_sha,':previous':row.cutover_revision,':next':{N:next},':value':{S:text},':sha':{S:sha},':phase':{S:'consumers-paused'},':true':{BOOL:true},':false':{BOOL:false},':fenced':{S:'fenced'},':handoff':row.backend_handoff_receipt};
  let expression='SET #field=:value,#sha=:sha,#revision=:next';if(complete){Object.assign(values,{':complete':{S:'postwrite-complete'}});expression+=',cutover_phase=:complete,release_requested=:true,api_admission_restored=:true,consumer_admission_restored=:true,deployment_admission_restored=:true,api_pause_verified=:false';}
  const update={TableName:TABLE,Key:{pk:{S:'run#'+run}},UpdateExpression:expression,ConditionExpression:'execution_arn=:execution AND source_sha=:source AND #revision=:previous AND cutover_phase=:phase AND database_mutations_started=:true AND release_requested=:false AND postgres_fence_state=:fenced AND backend_handoff_receipt=:handoff AND api_admission_restored=:false AND consumer_admission_restored=:false AND deployment_admission_restored=:false AND (attribute_not_exists(#field) OR (#field=:value AND #sha=:sha))',ExpressionAttributeNames:{'#field':field,'#sha':field+'_sha256','#revision':'cutover_revision'},ExpressionAttributeValues:values};
  try{await aws('ddb','TransactWriteItems',{TransactItems:[{Update:update},{ConditionCheck:{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn=:execution AND #kind=:kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':row.execution_arn,':kind':{S:'cutover-hold'}}}}]});}
  catch(error){const found=(await get('run#'+run)).Item;if(found?.cutover_revision?.N!==next||found[field]?.S!==text||found[field+'_sha256']?.S!==sha||found.database_mutations_started?.BOOL!==true||complete&&(found.cutover_phase?.S!=='postwrite-complete'||found.release_requested?.BOOL!==true))throw error;}
  const found=(await get('run#'+run)).Item;if(found?.cutover_revision?.N!==next||found[field]?.S!==text||found[field+'_sha256']?.S!==sha||found.database_mutations_started?.BOOL!==true)throw Error('FINAL_HANDOFF_RECORD_NOT_DURABLE');
 }
 return{
  async stop(){
   async function owned(){
    const [result,owner]=await Promise.all([get('run#'+run),get('maintenance')]);const row=result.Item;
    if(row?.source_sha?.S!==source||row.kind?.S!=='cutover-hold'||row.execution_arn?.S!=='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run||owner.Item?.kind?.S!=='cutover-hold'||owner.Item.execution_arn?.S!==row.execution_arn.S||row.cutover_phase?.S!=='consumers-paused'||row.database_mutations_started?.BOOL!==true||row.release_requested?.BOOL!==false||!row.backend_handoff_intent||!Number.isSafeInteger(Number(row.cutover_revision?.N))||Number(row.cutover_revision.N)<0||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('OWNED_POSTWRITE_STOP_REQUIRED');
    return row;
   }
   let row=await owned();const plan=validateConsumerPlan(bound(row,'consumer_plan')),deployment=bound(row,'deployment_freeze_plan','deployment_freeze_sha256');
   if(plan.scope.purpose!=='production')throw Error('PRODUCTION_STOP_REQUIRED');
   await record({row},'d1_emergency_stop_intent',{version:1,runId:run,sourceSha:source,admissionOnly:true});
   const freeze=createDeploymentFreeze(github,{assertOwnership:owned});await freeze.freeze(deployment);
   await owned();const current=await cloudflare('GET',base+'/settings');if(current.bindings.filter(v=>v.name==='DB'&&v.type==='d1'&&v.id===TARGET.databaseId).length!==1)throw Error('FIXED_D1_STOP_TARGET_REQUIRED');
   if(current.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE')?.text!=='paused'){
    const bindings=current.bindings.filter(v=>v.name!=='MIGRATION_TRAFFIC_STATE').map(v=>({name:v.name,type:'inherit'}));bindings.push({name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'});await owned();let failure;try{await cloudflare('PATCH',base+'/settings',{bindings});}catch(error){failure=error;}
    try{await verifyProductionTraffic(true,fetcher);}catch(error){if(failure)throw failure;throw error;}
   }
   const control=createConsumerControl((command,input)=>aws('lambda',command,input),{assertOwnership:owned});await control.pause(plan);
   let paused=false;for(let i=0;i<180;i++){await owned();if((await control.inspect(plan)).admissionPaused){paused=true;break;}await sleep(1000);}if(!paused)throw Error('POSTWRITE_STOP_INCOMPLETE');
   await verifyProductionTraffic(true,fetcher);const frozen=await freeze.inspect(deployment);if(!frozen.admissionFrozen||!frozen.githubRunsDrained)throw Error('STOP_DEPLOYMENTS_NOT_DRAINED');row=await owned();await record({row},'d1_emergency_stop_receipt',{version:1,runId:run,sourceSha:source,admissionPaused:true,inFlightDrainProven:false,productionSafe:false});return{admissionPaused:true,inFlightDrainProven:false,productionSafe:false};
  },
  async resume(){
   const before=(await get('run#'+run)).Item;let context;
   if(before?.d1_resume_receipt){await observed();return{resumed:true,productionSafe:false};}
   const settings=await cloudflare('GET',base+'/settings'),running=['running',undefined].includes(settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE')?.text);
   if(running&&!before?.d1_resume_intent)throw Error('UNOWNED_D1_RESUME');
   context=await observed({traffic:running?'running':'paused',consumers:before?.d1_resume_intent?'resuming':'paused'});
   if(!context.row.d1_resume_intent){const desired={...settings,bindings:settings.bindings.map(v=>v.name==='MIGRATION_TRAFFIC_STATE'?{name:v.name,type:'plain_text',text:'running'}:v)};await record(context,'d1_resume_intent',{version:1,runId:run,sourceSha:source,backendReceiptSha256:context.row.backend_handoff_receipt_sha256.S,apiBindingsSha256:apiFingerprint(desired)});}
   if(!running){
    await observed({traffic:'paused',consumers:'resuming'});const current=await cloudflare('GET',base+'/settings'),bindings=current.bindings.filter(v=>v.name!=='MIGRATION_TRAFFIC_STATE').map(v=>({name:v.name,type:'inherit'}));bindings.push({name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'running'});
    let failure;try{await cloudflare('PATCH',base+'/settings',{bindings});}catch(error){failure=error;}
    try{await observed({consumers:'resuming'});}catch(error){if(failure)throw failure;throw error;}
   }
   const control=createConsumerControl((command,input)=>aws('lambda',command,input),{assertOwnership:async()=>{await observed({consumers:'resuming'});}});
   context=await observed({consumers:'resuming'});await control.resume(context.consumer);
   let complete=false;for(let i=0;i<180;i++){context=await observed({consumers:'resuming'});if((await control.inspect(context.consumer)).originalAdmissionRestored){complete=true;break;}await sleep(1000);}
   if(!complete)throw Error('D1_CONSUMER_RESUME_INCOMPLETE');await verifyProductionTraffic(false,fetcher);context=await observed();
   const receipt={version:1,runId:run,sourceSha:source,target:TARGET,apiVersion:context.apiVersion,apiBindingsSha256:apiFingerprint(context.settings),backendReceiptSha256:context.row.backend_handoff_receipt_sha256.S,completedAt:now(),productionSafe:false};await record(context,'d1_resume_receipt',receipt);return{resumed:true,productionSafe:false};
  },
  async complete({smokeBuildArn,smokeRunId}){
   const existing=(await get('run#'+run)).Item;
   let context=await observed({deployments:existing?.d1_e2e_receipt?'restoring':'frozen'}),resumed=bound(context.row,'d1_resume_receipt');
   if(!/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-smoke-prod:[a-f0-9-]{36}$/.test(smokeBuildArn??'')||!/^[a-f0-9]{32}$/.test(smokeRunId??''))throw Error('NATIVE_D1_E2E_REQUIRED');
   const result=await aws('codebuild','BatchGetBuilds',{ids:[smokeBuildArn]}),build=result.builds?.[0];
   if(result.buildsNotFound?.length||result.builds?.length!==1||build.arn!==smokeBuildArn||build.projectName!=='videoq-db-smoke-prod'||build.buildStatus!=='SUCCEEDED'||build.buildComplete!==true||build.sourceVersion!==context.backup.sourceVersion||!Number.isFinite(Date.parse(build.startTime))||Date.parse(build.startTime)<Date.parse(resumed.completedAt)||!Number.isFinite(Date.parse(build.endTime))||Date.parse(build.endTime)<Date.parse(build.startTime))throw Error('NATIVE_D1_E2E_REQUIRED');
   for(const [name,value]of Object.entries({MAINTENANCE_RUN_ID:smokeRunId,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_STAGE:'smoke',MAINTENANCE_KIND:'smoke',VIDEOQ_D1_PRODUCTION_SMOKE:'true',VERIFY_AI_ANSWERS:'true'})){const matches=build.environment?.environmentVariables?.filter(v=>v.name===name);if(matches?.length!==1||matches[0].type!=='PLAINTEXT'||matches[0].value!==value)throw Error('NATIVE_D1_E2E_REQUIRED');}
   const e2e={version:1,runId:run,sourceSha:source,smokeBuildArn,smokeRunId,apiVersion:context.apiVersion,apiBindingsSha256:apiFingerprint(context.settings),completedAt:build.endTime};
   await record(context,'d1_e2e_receipt',e2e);
   const freeze=createDeploymentFreeze(github,{assertOwnership:async()=>{await observed({deployments:'restoring'});}});context=await observed({deployments:'restoring'});await freeze.restore(context.deployment);
   context=await observed({deployments:'original'});
   const receipt={version:1,runId:run,sourceSha:source,target:TARGET,smokeBuildArn,smokeRunId,apiVersion:context.apiVersion,postgresWritersRemainFenced:true,productionSafe:true};
   await record(context,'postwrite_completion_receipt',receipt,true);return{completed:true,releaseRequested:true,productionSafe:true};
  },
 };
}
module.exports={createFinalizer,validateCanonicalD1};
