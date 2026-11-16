// Trusted coordinator component. No CLI, credential loading or implicit caller.
const {requireStageSucceeded}=require('../../infra/db-maintenance/runtime/stage-proof.cjs');
const {createHash}=require('node:crypto');
const {createDeploymentFreeze,validateDeploymentFreezePlan}=require('./cutover-deployment-freeze.cjs');
const {definitionHash}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
const digest=s=>createHash('sha256').update(s).digest('hex');
function createOwnedDeploymentFreeze({aws,request,table,machine,expectedDefinitionHash,enabled=false,assertRestoreSafe=async()=>{throw Error('VERIFIED_DEPLOYMENT_RESTORE_HANDOFF_REQUIRED');}}){
 return async({action,run,source})=>{
  if(!enabled)throw Error('OWNED_DEPLOYMENT_FREEZE_DISABLED');
  if(!['freeze','inspect','restore'].includes(action)||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||!/^[a-f0-9]{64}$/.test(expectedDefinitionHash??''))throw Error('INVALID_OWNED_DEPLOYMENT_CONTEXT');
  const arn=machine.replace(':stateMachine:',':execution:')+':db-'+run,key={pk:{S:'run#'+run}};
  const get=name=>aws('ddb','GetItem',{TableName:table,Key:{pk:{S:name}},ConsistentRead:true});
  async function owned(){
   const [r,o,state,bound]=await Promise.all([get('run#'+run),get('maintenance'),aws('sfn','DescribeExecution',{executionArn:arn}),aws('sfn','DescribeStateMachineForExecution',{executionArn:arn})]);const row=r.Item,owner=o.Item;
   if(state.status!=='RUNNING'||typeof bound.definition!=='string'||definitionHash(JSON.parse(bound.definition))!==expectedDefinitionHash)throw Error('DEPLOYMENT_FREEZE_EXECUTION_REQUIRED');
   if(row?.kind?.S!=='cutover-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==source||row.cutover_phase?.S!=='holding'||row.release_requested?.BOOL!==false||row.database_mutations_started?.BOOL!==false||owner?.kind?.S!=='cutover-hold'||owner.execution_arn?.S!==arn||!/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N??'')||!Number.isSafeInteger(Number(row.cutover_revision.N))||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('DEPLOYMENT_FREEZE_OWNERSHIP_REQUIRED');
   if(row.deployment_admission_restored&&typeof row.deployment_admission_restored.BOOL!=='boolean')throw Error('INVALID_DEPLOYMENT_FREEZE_RECORD');await requireStageSucceeded(aws,row);return row;
  }
  function stored(row){
   if(typeof row.deployment_freeze_plan?.S!=='string'||digest(row.deployment_freeze_plan.S)!==row.deployment_freeze_sha256?.S||typeof row.deployment_admission_restored?.BOOL!=='boolean')throw Error('INVALID_DEPLOYMENT_FREEZE_RECORD');
   return validateDeploymentFreezePlan(JSON.parse(row.deployment_freeze_plan.S));
  }
  async function update(before,expression,extraNames,extraValues,condition){
   await aws('ddb','TransactWriteItems',{TransactItems:[
    {Update:{TableName:table,Key:key,UpdateExpression:expression+', #revision = :next',ConditionExpression:'execution_arn = :execution AND source_sha = :source AND #phase = :holding AND #revision = :previous AND release_requested = :false AND database_mutations_started = :false AND '+condition,
     ExpressionAttributeNames:{'#phase':'cutover_phase','#revision':'cutover_revision',...extraNames},ExpressionAttributeValues:{':execution':{S:arn},':source':{S:source},':holding':{S:'holding'},':previous':before.cutover_revision,':next':{N:String(Number(before.cutover_revision.N)+1)},':false':{BOOL:false},...extraValues}}},
    {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:'cutover-hold'}}}},
   ]});
  }
  let row=await owned(),plan;
  const adapter=createDeploymentFreeze(request,{assertOwnership:async operation=>{
   const current=await owned();if(current.deployment_freeze_sha256?.S!==digest(JSON.stringify(plan))||current.deployment_admission_restored?.BOOL!==false)throw Error('DEPLOYMENT_FREEZE_PLAN_CHANGED');stored(current);
   if(operation==='restore'){if(current.api_admission_restored?.BOOL===false)throw Error('API_RESTORATION_REQUIRED');if(current.consumer_admission_restored?.BOOL===false)throw Error('CONSUMER_RESTORATION_REQUIRED');await assertRestoreSafe({run,source,executionArn:arn});}
  }});
  if(!row.deployment_freeze_plan){
   if(action!=='freeze')throw Error('DEPLOYMENT_FREEZE_PLAN_REQUIRED');
   plan=await adapter.prepare();row=await owned();const serialized=JSON.stringify(plan),sha=digest(serialized);
   try{await update(row,'SET deployment_freeze_plan = :plan, deployment_freeze_sha256 = :sha, deployment_admission_restored = :false',{}, {':plan':{S:serialized},':sha':{S:sha}},'attribute_not_exists(deployment_freeze_plan)');}
   catch(error){const found=await owned();if(found.deployment_freeze_plan?.S!==serialized||found.deployment_freeze_sha256?.S!==sha||found.deployment_admission_restored?.BOOL!==false)throw error;}
   row=await owned();
  }
  plan=stored(row);
  if(action==='inspect')return adapter.inspect(plan);
  if(action==='freeze'){
   if(row.deployment_admission_restored.BOOL)throw Error('DEPLOYMENT_FREEZE_ALREADY_RESTORED');return adapter.freeze(plan);
  }
  if(row.api_admission_restored?.BOOL===false)throw Error('API_RESTORATION_REQUIRED');
  if(row.consumer_admission_restored?.BOOL===false)throw Error('CONSUMER_RESTORATION_REQUIRED');
  await assertRestoreSafe({run,source,executionArn:arn});
  if(!row.deployment_admission_restored.BOOL){
   const result=await adapter.restore(plan);if(!result.originalAdmissionRestored)throw Error('DEPLOYMENT_RESTORE_INCOMPLETE');row=await owned();stored(row);
   try{await update(row,'SET deployment_admission_restored = :true',{}, {':true':{BOOL:true},':sha':row.deployment_freeze_sha256},'deployment_freeze_sha256 = :sha AND deployment_admission_restored = :false');}
   catch(error){const found=await owned();if(found.deployment_freeze_sha256?.S!==row.deployment_freeze_sha256.S||found.deployment_admission_restored?.BOOL!==true)throw error;}
  }
  // Read back each workflow even on a duplicate completion. Never invent a
  // successful restoration from the DDB marker alone.
  const probe=await createDeploymentFreeze(request).prepare();
  if(probe.workflows.some((w,i)=>w.id!==plan.workflows[i].id||w.wasActive!==plan.workflows[i].wasActive))throw Error('DEPLOYMENT_RESTORE_DRIFT');
  await owned();await assertRestoreSafe({run,source,executionArn:arn});return{originalAdmissionRestored:true};
 };
}
module.exports={createOwnedDeploymentFreeze};
