// Owned pre-DB-mutation pause/abort composition; no CLI or implicit activation.
const {requireStageSucceeded}=require('../../infra/db-maintenance/runtime/stage-proof.cjs');
const {createHash}=require('node:crypto');
const {createApiTrafficControl,validateApiTrafficPlan}=require('./cutover-api-traffic.cjs');
const {definitionHash}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
const digest=s=>createHash('sha256').update(s).digest('hex');
async function verifyProductionTraffic(paused,fetcher=fetch){
 async function read(path){
  const response=await fetcher('https://videoq.jp'+path,{method:'GET',redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(20000)});
  if(!response.body)throw Error('API_TRAFFIC_PROBE_FAILED');const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>8192)throw Error('API_TRAFFIC_PROBE_FAILED');chunks.push(Buffer.from(chunk));}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('API_TRAFFIC_PROBE_FAILED');}return{response,body};
 }
 if((await read('/health')).response.status!==200)throw Error('API_TRAFFIC_LIVENESS_FAILED');
 const ready=await read('/ready');
 if(paused){
  const session=await read('/api/auth/get-session');
  for(const {response,body}of[ready,session])if(response.status!==503||body.error?.code!=='MIGRATION_PAUSED'||response.headers.get('retry-after')!=='60'||response.headers.get('cache-control')!=='no-store')throw Error('API_APPLICATION_PAUSE_NOT_VERIFIED');
  return{applicationPauseVerified:true,inFlightDrainProven:false};
 }
 if(ready.response.status!==200||ready.body.data?.status!=='ready'||ready.body.data?.db!=='ok')throw Error('API_APPLICATION_READY_NOT_VERIFIED');return{applicationReadyVerified:true,inFlightDrainProven:false};
}
function createOwnedApiTraffic({aws,request,table,machine,expectedDefinitionHash,enabled=false,assertDeploymentsFrozen,assertRestoreSafe=async()=>{throw Error('VERIFIED_API_RESTORE_HANDOFF_REQUIRED');},verifyTraffic=verifyProductionTraffic}){
 return async({action,run,source})=>{
  if(!enabled)throw Error('OWNED_API_TRAFFIC_DISABLED');
  if(!['pause','inspect','restore'].includes(action)||typeof assertDeploymentsFrozen!=='function'||typeof verifyTraffic!=='function'||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||!/^[a-f0-9]{64}$/.test(expectedDefinitionHash??''))throw Error('INVALID_OWNED_API_CONTEXT');
  const arn=machine.replace(':stateMachine:',':execution:')+':db-'+run,key={pk:{S:'run#'+run}};
  const get=name=>aws('ddb','GetItem',{TableName:table,Key:{pk:{S:name}},ConsistentRead:true});
  async function owned(){
   const[r,o,state,bound]=await Promise.all([get('run#'+run),get('maintenance'),aws('sfn','DescribeExecution',{executionArn:arn}),aws('sfn','DescribeStateMachineForExecution',{executionArn:arn})]);const row=r.Item;
   if(state.status!=='RUNNING'||typeof bound.definition!=='string'||definitionHash(JSON.parse(bound.definition))!==expectedDefinitionHash)throw Error('API_TRAFFIC_EXECUTION_REQUIRED');
   if(row?.kind?.S!=='cutover-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==source||!['holding','consumers-paused'].includes(row.cutover_phase?.S)||action==='pause'&&row.cutover_phase.S!=='holding'||row.release_requested?.BOOL!==false||row.database_mutations_started?.BOOL!==false||row.deployment_admission_restored?.BOOL!==false||o.Item?.kind?.S!=='cutover-hold'||o.Item.execution_arn?.S!==arn||!/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N??'')||!Number.isSafeInteger(Number(row.cutover_revision.N))||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('API_TRAFFIC_OWNERSHIP_REQUIRED');
   await requireStageSucceeded(aws,row);return row;
  }
  function stored(row){if(typeof row.api_traffic_plan?.S!=='string'||digest(row.api_traffic_plan.S)!==row.api_traffic_sha256?.S||typeof row.api_admission_restored?.BOOL!=='boolean'||typeof row.api_pause_verified?.BOOL!=='boolean')throw Error('INVALID_API_TRAFFIC_RECORD');const plan=validateApiTrafficPlan(JSON.parse(row.api_traffic_plan.S));if(plan.scope.purpose!=='production')throw Error('INVALID_API_TRAFFIC_RECORD');return plan;}
  async function update(row,expression,values,condition){
   await aws('ddb','TransactWriteItems',{TransactItems:[
    {Update:{TableName:table,Key:key,UpdateExpression:expression+', #revision = :next',ConditionExpression:'execution_arn = :execution AND source_sha = :source AND #phase = :phase AND #revision = :previous AND release_requested = :false AND database_mutations_started = :false AND deployment_admission_restored = :false AND '+condition,ExpressionAttributeNames:{'#phase':'cutover_phase','#revision':'cutover_revision'},ExpressionAttributeValues:{':execution':{S:arn},':source':{S:source},':phase':row.cutover_phase,':previous':row.cutover_revision,':next':{N:String(Number(row.cutover_revision.N)+1)},':false':{BOOL:false},...values}}},
    {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:'cutover-hold'}}}},
   ]});
  }
  let row=await owned(),plan;
  await assertDeploymentsFrozen({run,source,executionArn:arn,row});
  const adapter=createApiTrafficControl(request,{assertOwnership:async()=>{const current=await owned();stored(current);if(current.api_traffic_sha256.S!==digest(JSON.stringify(plan))||current.api_admission_restored.BOOL)throw Error('API_TRAFFIC_PLAN_CHANGED');await assertDeploymentsFrozen({run,source,executionArn:arn,row:current});},assertRestoreSafe:async()=>assertRestoreSafe({run,source,executionArn:arn,plan})});
  if(!row.api_traffic_plan){
   if(action!=='pause')throw Error('API_TRAFFIC_PLAN_REQUIRED');plan=await adapter.prepare({purpose:'production'});row=await owned();const serialized=JSON.stringify(plan),sha=digest(serialized);
   try{await update(row,'SET api_traffic_plan = :plan, api_traffic_sha256 = :sha, api_admission_restored = :false, api_pause_verified = :false',{':plan':{S:serialized},':sha':{S:sha}},'attribute_not_exists(api_traffic_plan)');}
   catch(error){const found=await owned();if(found.api_traffic_plan?.S!==serialized||found.api_traffic_sha256?.S!==sha||found.api_admission_restored?.BOOL!==false||found.api_pause_verified?.BOOL!==false)throw error;}
   row=await owned();
  }
  plan=stored(row);
  if(action==='inspect')return adapter.inspect(plan);
  if(action==='pause'&&row.api_admission_restored.BOOL)throw Error('API_TRAFFIC_ALREADY_RESTORED');
  if(action==='restore')await assertRestoreSafe({run,source,executionArn:arn,plan});
  if(!row.api_admission_restored.BOOL)await adapter.change(plan,action==='pause');
  const receipt=await verifyTraffic(action==='pause');
  if(action==='pause'?receipt?.applicationPauseVerified!==true:receipt?.applicationReadyVerified!==true)throw Error('API_TRAFFIC_PROBE_REQUIRED');
  row=await owned();stored(row);if(row.api_traffic_sha256.S!==digest(JSON.stringify(plan)))throw Error('API_TRAFFIC_PLAN_CHANGED');
  const restored=action==='restore',verified=!restored;
  if(row.api_admission_restored.BOOL!==restored||row.api_pause_verified.BOOL!==verified){
   try{await update(row,'SET api_admission_restored = :restored, api_pause_verified = :verified',{':restored':{BOOL:restored},':verified':{BOOL:verified},':sha':{S:digest(JSON.stringify(plan))}},'api_traffic_sha256 = :sha AND api_admission_restored = :false');}
   catch(error){const found=await owned();if(found.api_traffic_sha256?.S!==digest(JSON.stringify(plan))||found.api_admission_restored?.BOOL!==restored||found.api_pause_verified?.BOOL!==verified)throw error;}
  }
  // Duplicate completion must inspect real metadata and application responses too.
  const state=await adapter.inspect(plan);if(restored?!state.originalTrafficRestored:!state.trafficPaused)throw Error('API_TRAFFIC_COMPLETION_DRIFT');await owned();return{...state,...receipt};
 };
}
module.exports={createOwnedApiTraffic,verifyProductionTraffic};
