// Fixed, pre-write operator composition. No DB credential, SSM, IAM or SQL API.
const {definitionHash,assertFenceReleased}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
const {requireStageSucceeded}=require('../../infra/db-maintenance/runtime/stage-proof.cjs');
const {createHash}=require('node:crypto');
const {createOwnedDeploymentFreeze}=require('./cutover-owned-deployment-freeze.cjs');
const {createDeploymentFreeze,validateDeploymentFreezePlan}=require('./cutover-deployment-freeze.cjs');
const {createApiTrafficControl,validateApiTrafficPlan}=require('./cutover-api-traffic.cjs');
const {createOwnedApiTraffic,verifyProductionTraffic}=require('./cutover-owned-api-traffic.cjs');
const {createConsumerControl,validateConsumerPlan}=require('./cutover-sqs-consumers.cjs');
const {publicApiState}=require('./cutover-consumer-control.cjs');
const hash=s=>createHash('sha256').update(s).digest('hex');
const ACTIONS=['freeze-deployments','inspect-deployments','pause-api','inspect-api','restore-api','restore-deployments'];
const SETTINGS='accounts/12daec56fdba43f677f2766ee26a5a39/workers/scripts/videoq-api/settings';
function createAdmissionOperator({aws,github,cloudflare,table,machine,expectedDefinitionHash,enabled=false,verifyTraffic=verifyProductionTraffic}){
 return async({action,run,source})=>{
  if(!enabled)throw Error('ADMISSION_OPERATOR_DISABLED');
  if(!ACTIONS.includes(action)||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??''))throw Error('INVALID_ADMISSION_OPERATION');
  const arn=machine.replace(':stateMachine:',':execution:')+':db-'+run;
  const get=key=>aws('ddb','GetItem',{TableName:table,Key:{pk:{S:key}},ConsistentRead:true});
  async function owned(){
   const[r,o,state,bound]=await Promise.all([get('run#'+run),get('maintenance'),aws('sfn','DescribeExecution',{executionArn:arn}),aws('sfn','DescribeStateMachineForExecution',{executionArn:arn})]);const row=r.Item;
   if(state.status!=='RUNNING'||typeof bound.definition!=='string'||definitionHash(JSON.parse(bound.definition))!==expectedDefinitionHash)throw Error('ADMISSION_EXECUTION_REQUIRED');
   if(row?.kind?.S!=='cutover-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==source||row.release_requested?.BOOL!==false||row.database_mutations_started?.BOOL!==false||!['holding','consumers-paused'].includes(row.cutover_phase?.S)||o.Item?.kind?.S!=='cutover-hold'||o.Item.execution_arn?.S!==arn)throw Error('ADMISSION_OPERATOR_OWNERSHIP_REQUIRED');
   assertFenceReleased(row);
   await requireStageSucceeded(aws,row);return row;
  }
  function baseline(row){
   if(typeof row.operator_admission_baseline?.S!=='string'||hash(row.operator_admission_baseline.S)!==row.operator_admission_sha256?.S)throw Error('ADMISSION_BACKEND_BASELINE_REQUIRED');
   const value=JSON.parse(row.operator_admission_baseline.S);
   if(typeof value.serialized!=='string'||!['running',null].includes(value.traffic)||Object.keys(value).sort().join(',')!=='serialized,traffic')throw Error('INVALID_ADMISSION_BACKEND_BASELINE');
   return value;
  }
  async function backendUnchanged(){
   const row=await owned(),original=baseline(row),current=publicApiState(await cloudflare('GET',SETTINGS));
   if(current.serialized!==original.serialized)throw Error('ADMISSION_BACKEND_CHANGED');return row;
  }
  async function frozen(){
   const row=await owned();if(row.deployment_admission_restored?.BOOL!==false||typeof row.deployment_freeze_plan?.S!=='string'||hash(row.deployment_freeze_plan.S)!==row.deployment_freeze_sha256?.S)throw Error('DEPLOYMENT_FREEZE_REQUIRED');
   const plan=validateDeploymentFreezePlan(JSON.parse(row.deployment_freeze_plan.S)),state=await createDeploymentFreeze(github).inspect(plan);
   if(!state.admissionFrozen||!state.githubRunsDrained)throw Error('DEPLOYMENT_DRAIN_REQUIRED');return row;
  }
  async function consumersConsistent(row){
   if(!row.consumer_plan&&!row.consumer_plan_sha256){if(row.consumer_admission_restored)throw Error('CONSUMER_PLAN_REQUIRED');return;}
   if(typeof row.consumer_plan?.S!=='string'||hash(row.consumer_plan.S)!==row.consumer_plan_sha256?.S)throw Error('INVALID_CONSUMER_PLAN_RECORD');
   const plan=validateConsumerPlan(JSON.parse(row.consumer_plan.S));if(plan.scope.purpose!=='production')throw Error('INVALID_CONSUMER_PLAN_RECORD');
   const state=await createConsumerControl((command,value)=>aws('lambda',command,value)).inspect(plan);
   if(row.consumer_admission_restored?.BOOL===false?!state.admissionPaused:row.consumer_admission_restored?.BOOL!==true||!state.originalAdmissionRestored)throw Error('CONSUMER_ADMISSION_DRIFT');
  }
  const deployment=createOwnedDeploymentFreeze({aws,request:github,table,machine,expectedDefinitionHash,enabled:true,assertRestoreSafe:async()=>{
   const row=await backendUnchanged();await consumersConsistent(row);
   if(row.api_traffic_plan){if(hash(row.api_traffic_plan.S)!==row.api_traffic_sha256?.S)throw Error('INVALID_API_TRAFFIC_RECORD');const probe=await createApiTrafficControl(cloudflare).inspect(validateApiTrafficPlan(JSON.parse(row.api_traffic_plan.S)));if(!probe.originalTrafficRestored||row.api_admission_restored?.BOOL!==true)throw Error('API_RESTORATION_REQUIRED');}
   else if(row.api_admission_restored||row.api_pause_verified)throw Error('INVALID_API_TRAFFIC_RECORD');
   const receipt=await verifyTraffic(false);if(receipt?.applicationReadyVerified!==true)throw Error('API_APPLICATION_READY_NOT_VERIFIED');
  }});
  const api=createOwnedApiTraffic({aws,request:cloudflare,table,machine,expectedDefinitionHash,enabled:true,assertDeploymentsFrozen:frozen,verifyTraffic,assertRestoreSafe:async()=>{const row=await backendUnchanged();await consumersConsistent(row);}});
  await owned();
  if(action==='freeze-deployments'){
   let row=await owned();
   if(row.operator_admission_baseline||row.operator_admission_sha256){await backendUnchanged();const r=await deployment({action:'freeze',run,source});return{deploymentAdmissionFrozen:r.admissionFrozen,githubRunsDrained:r.githubRunsDrained,inFlightDrainProven:false};}
   if(row.api_traffic_plan||row.api_admission_restored||row.api_pause_verified)throw Error('ORIGINAL_ADMISSION_BASELINE_REQUIRED');
   const current=publicApiState(await cloudflare('GET',SETTINGS));if(![undefined,'running'].includes(current.traffic))throw Error('ORIGINAL_API_MUST_BE_RUNNING');
   const value=JSON.stringify({serialized:current.serialized,traffic:current.traffic??null}),sha=hash(value);
   row=await owned();const revision=row.cutover_revision?.N;
   if(!/^(0|[1-9][0-9]*)$/.test(revision??'')||!Number.isSafeInteger(Number(revision))||Number(revision)>=Number.MAX_SAFE_INTEGER)throw Error('INVALID_ADMISSION_REVISION');
   try{await aws('ddb','TransactWriteItems',{TransactItems:[
    {Update:{TableName:table,Key:{pk:{S:'run#'+run}},UpdateExpression:'SET operator_admission_baseline = :baseline, operator_admission_sha256 = :sha, #revision = :next',ConditionExpression:'execution_arn = :execution AND source_sha = :source AND #phase = :holding AND #revision = :previous AND release_requested = :false AND database_mutations_started = :false AND attribute_not_exists(api_traffic_plan) AND attribute_not_exists(operator_admission_baseline) AND attribute_not_exists(operator_admission_sha256)',ExpressionAttributeNames:{'#phase':'cutover_phase','#revision':'cutover_revision'},ExpressionAttributeValues:{':baseline':{S:value},':sha':{S:sha},':next':{N:String(Number(revision)+1)},':previous':row.cutover_revision,':execution':{S:arn},':source':{S:source},':holding':{S:'holding'},':false':{BOOL:false}}}},
    {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:'cutover-hold'}}}},
   ]});}catch(error){const found=await owned();if(found.operator_admission_baseline?.S!==value||found.operator_admission_sha256?.S!==sha)throw error;}
   await backendUnchanged();const receipt=await deployment({action:'freeze',run,source});await backendUnchanged();return{deploymentAdmissionFrozen:receipt.admissionFrozen,githubRunsDrained:receipt.githubRunsDrained,inFlightDrainProven:false};
  }
  if(action==='inspect-deployments'){const receipt=await deployment({action:'inspect',run,source});return{deploymentAdmissionFrozen:receipt.admissionFrozen,githubRunsDrained:receipt.githubRunsDrained,inFlightDrainProven:false};}
  if(action==='restore-deployments'){await deployment({action:'restore',run,source});return{deploymentAdmissionRestored:true,inFlightDrainProven:false};}
  await backendUnchanged();const receipt=await api({action:action==='pause-api'?'pause':action==='restore-api'?'restore':'inspect',run,source});
  return{apiPauseVerified:receipt.applicationPauseVerified??receipt.trafficPaused,apiRestored:receipt.applicationReadyVerified??receipt.originalTrafficRestored,inFlightDrainProven:false};
 };
}
module.exports={createAdmissionOperator,ACTIONS};
