// One owned native build attempt. An ambiguous StartBuild is reconciled by
// metadata, never automatically retried after an idempotency token expires.
const {resourceDigest}=require('./d1-resource-journal.cjs');
const TABLE='videoq-db-maintenance-prod',PROJECT='videoq-db-smoke-prod';
const ARN=/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-smoke-prod:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function createResourceSmokeLauncher({aws,journal,proof,run,source,executorSha256,enabled=false}){
 if(typeof aws!=='function'||['assertExecutor','assertPending'].some(k=>typeof journal?.[k]!=='function')||typeof proof?.launchInput!=='function'||typeof proof?.matchesBuild!=='function'||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||!/^[a-f0-9]{64}$/.test(executorSha256??''))throw Error('RESOURCE_SMOKE_LAUNCH_CONTEXT_REQUIRED');
 const key={pk:{S:'run#'+run}},execution='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
 const read=async()=>(await aws('ddb','GetItem',{TableName:TABLE,Key:key,ConsistentRead:true})).Item;
 async function context(plan){
  if(!enabled)throw Error('RESOURCE_SMOKE_LAUNCH_DISABLED');
  const sha=resourceDigest(plan);await journal.assertExecutor();await journal.assertPending({step:'verify-e2e',planSha256:sha});
  const input=await proof.launchInput(plan.nativePlan,sha),row=await read();
  if(row?.execution_arn?.S!==execution||row.source_sha?.S!==source||row.kind?.S!=='d1-resource-hold'||row.resource_phase?.S!=='holding'||row.release_requested?.BOOL!==false||row.resource_executor_sha256?.S!==executorSha256||! /^(0|[1-9][0-9]*)$/.test(row.resource_revision?.N??'')||!Number.isSafeInteger(Number(row.resource_revision.N))||Number(row.resource_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('RESOURCE_SMOKE_LAUNCH_OWNERSHIP_REQUIRED');
  return{sha,input,row};
 }
 function matches(row,plan,sha){return row.resource_smoke_action_id?.S===plan.nativePlan.actionId&&row.resource_smoke_plan_sha256?.S===sha&&row.resource_smoke_source_version?.S===plan.nativePlan.sourceVersion&&row.resource_smoke_state?.S==='starting';}
 async function persist(plan,before,sha,buildArn){
  const next=String(Number(before.resource_revision.N)+1),values={':execution':{S:execution},':kind':{S:'d1-resource-hold'},':source':{S:source},':executor':{S:executorSha256},':holding':{S:'holding'},':false':{BOOL:false},':previous':before.resource_revision,':next':{N:next},':action':{S:plan.nativePlan.actionId},':plan':{S:sha},':version':{S:plan.nativePlan.sourceVersion},':starting':{S:'starting'}};
  let update='SET resource_revision=:next,resource_smoke_action_id=:action,resource_smoke_plan_sha256=:plan,resource_smoke_source_version=:version,resource_smoke_state=:starting';
  let condition='attribute_not_exists(resource_smoke_action_id)';
  if(buildArn){values[':build']={S:buildArn};update+=' ,resource_smoke_build_arn=:build';condition='resource_smoke_action_id=:action AND resource_smoke_plan_sha256=:plan AND resource_smoke_source_version=:version AND resource_smoke_state=:starting AND attribute_not_exists(resource_smoke_build_arn)';}
  const transaction={TransactItems:[{Update:{TableName:TABLE,Key:key,UpdateExpression:update,ConditionExpression:'execution_arn=:execution AND #kind=:kind AND source_sha=:source AND resource_executor_sha256=:executor AND resource_phase=:holding AND release_requested=:false AND resource_revision=:previous AND '+condition,ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:values}},{ConditionCheck:{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn=:execution AND #kind=:kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:execution},':kind':{S:'d1-resource-hold'}}}}]};
  await journal.assertExecutor();await journal.assertPending({step:'verify-e2e',planSha256:sha});
  try{await aws('ddb','TransactWriteItems',transaction);}catch{ /* Exact durable readback below also reconciles a lost write response. */ }
  const row=await read();if(row?.resource_revision?.N!==next||!matches(row,plan,sha)||(buildArn?row.resource_smoke_build_arn?.S!==buildArn:row.resource_smoke_build_arn!==undefined))throw Error('RESOURCE_SMOKE_REGISTRATION_UNCERTAIN');
  await journal.assertExecutor();return row;
 }
 async function buildMatches(arn,input,plan){
  if(!ARN.test(arn??''))return false;
  return proof.matchesBuild(plan.nativePlan,arn,resourceDigest(plan));
 }
 async function reconcile(plan,c){
  const found=[];let token;const seen=new Set();
  for(let page=0;page<20;page++){
   await journal.assertExecutor();const response=await aws('codebuild','ListBuildsForProject',{projectName:PROJECT,sortOrder:'DESCENDING',...(token?{nextToken:token}:{})});
   if(!Array.isArray(response.ids)||response.ids.length>100)throw Error('RESOURCE_SMOKE_BUILD_INVENTORY_REQUIRED');
   for(const id of response.ids){const arn=id.startsWith('arn:')?id:'arn:aws:codebuild:ap-northeast-1:257240362763:build/'+id;if(await buildMatches(arn,c.input,plan))found.push(arn);}
   token=response.nextToken;if(!token)break;if(typeof token!=='string'||seen.has(token)||page===19)throw Error('RESOURCE_SMOKE_BUILD_INVENTORY_INCOMPLETE');seen.add(token);
  }
  if(found.length!==1)throw Error('RESOURCE_SMOKE_START_RECONCILIATION_REQUIRED');
  const latest=await context(plan);if(!matches(latest.row,plan,latest.sha)||latest.row.resource_smoke_build_arn)throw Error('RESOURCE_SMOKE_REGISTRATION_CHANGED');
  await persist(plan,latest.row,latest.sha,found[0]);return{buildArn:found[0],pending:true};
 }
 return{async advance(plan){
  let c=await context(plan);
  if(c.row.resource_smoke_action_id){
   if(!matches(c.row,plan,c.sha))throw Error('RESOURCE_SMOKE_ACTION_CHANGED');
   if(c.row.resource_smoke_build_arn){if(!await buildMatches(c.row.resource_smoke_build_arn.S,c.input,plan))throw Error('RESOURCE_SMOKE_REGISTERED_BUILD_CHANGED');await journal.assertExecutor();return{buildArn:c.row.resource_smoke_build_arn.S,pending:true};}
   return reconcile(plan,c);
  }
  await persist(plan,c.row,c.sha); // Persist attempt BEFORE StartBuild, including crashes before dispatch.
  c=await context(plan);if(!matches(c.row,plan,c.sha)||c.row.resource_smoke_build_arn)throw Error('RESOURCE_SMOKE_REGISTRATION_CHANGED');
  let result;try{result=await aws('codebuild','StartBuild',c.input);}catch{throw Error('RESOURCE_SMOKE_START_RECONCILIATION_REQUIRED');}
  const arn=result.build?.arn;if(!await buildMatches(arn,c.input,plan))throw Error('RESOURCE_SMOKE_START_RECONCILIATION_REQUIRED');
  c=await context(plan);if(!matches(c.row,plan,c.sha)||c.row.resource_smoke_build_arn)throw Error('RESOURCE_SMOKE_REGISTRATION_CHANGED');
  await persist(plan,c.row,c.sha,arn);return{buildArn:arn,pending:true};
 }};
}
module.exports={createResourceSmokeLauncher};
