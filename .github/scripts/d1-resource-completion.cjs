// Trusted completion gate. No direct lock deletion: the existing state machine
// releases only after this conditional receipt is durable. Disabled by default.
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const TABLE='videoq-db-maintenance-prod',KIND='d1-resource-hold';
const MACHINE='arn:aws:states:ap-northeast-1:257240362763:stateMachine:videoq-db-maintenance-prod';
const TARGET={accountId:'12daec56fdba43f677f2766ee26a5a39',databaseId:'587bd210-6d9d-4f32-abb7-a490013e65d3',largeIndex:'videoq-prod-scenes-1536',smallIndex:'videoq-prod-scenes-768'};
function stepsVerified(steps){return Array.isArray(steps)&&steps.length===RESOURCE_STEPS.length&&steps.every((row,i)=>row.step===RESOURCE_STEPS[i]&&row.state==='verified'&&/^[a-f0-9]{64}$/.test(row.planSha256??'')&&/^[a-f0-9]{64}$/.test(row.receiptSha256??''));}
function validateCurrent(value,source,steps){
 const fields=['apiAdmissionRestored','consumerAdmissionRestored','deploymentAdmissionRestored','sourceFenced','targetUnfenced','accountId','databaseId','largeIndex','smallIndex','apiVersion','smokeBuildArn','smokeSourceSha','smokeCompletedAt','e2eStepReceiptSha256'];
 if(!value||Object.keys(value).sort().join(',')!==[...fields].sort().join(',')||fields.slice(0,5).some(key=>value[key]!==true)||Object.entries(TARGET).some(([key,expected])=>value[key]!==expected)||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.apiVersion??'')||!/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-smoke-prod:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.smokeBuildArn??'')||value.smokeSourceSha!==source||typeof value.smokeCompletedAt!=='string'||!Number.isFinite(Date.parse(value.smokeCompletedAt))||value.e2eStepReceiptSha256!==steps[RESOURCE_STEPS.indexOf('verify-e2e')].receiptSha256)throw Error('RESOURCE_COMPLETION_CURRENT_PROOF_REQUIRED');
 return value;
}
function createResourceCompletion({aws,journal,run,source,executorToken,verifyCurrentState,enabled=false}){
 if(typeof aws!=='function'||typeof journal?.assertExecutor!=='function'||typeof journal?.inspect!=='function'||typeof verifyCurrentState!=='function'||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||!/^[a-f0-9]{64}$/.test(executorToken??''))throw Error('RESOURCE_COMPLETION_CONTEXT_REQUIRED');
 const arn=MACHINE.replace(':stateMachine:',':execution:')+':db-'+run,executor=resourceDigest({executorToken});
 const read=async()=>(await aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:'run#'+run}},ConsistentRead:true})).Item;
 function completed(row){
  if(row?.resource_phase?.S!=='verified')return null;
  let receipt;try{receipt=JSON.parse(row.resource_completion_receipt.S);}catch{throw Error('RESOURCE_COMPLETION_RECORD_INVALID');}
  let steps;try{steps=JSON.parse(row.resource_steps.S);}catch{throw Error('RESOURCE_COMPLETION_RECORD_INVALID');}
  if(row.execution_arn?.S!==arn||row.source_sha?.S!==source||row.kind?.S!==KIND||row.resource_executor_sha256?.S!==executor||row.release_requested?.BOOL!==true||['api_admission_restored','consumer_admission_restored','deployment_admission_restored'].some(key=>row[key]?.BOOL!==true)||resourceDigest(receipt)!==row.resource_completion_receipt_sha256?.S||receipt.version!==1||receipt.run!==run||receipt.source!==source||!stepsVerified(steps)||resourceDigest(steps)!==row.resource_steps_sha256?.S||resourceDigest(receipt.steps)!==resourceDigest(steps))throw Error('RESOURCE_COMPLETION_RECORD_INVALID');
  validateCurrent(receipt.current,source,steps);
  return{releaseRequested:true,receiptSha256:row.resource_completion_receipt_sha256.S};
 }
 return{
  async request(){
   if(!enabled)throw Error('RESOURCE_COMPLETION_DISABLED');
   const prior=completed(await read());if(prior)return prior;
   await journal.assertExecutor();const before=await journal.inspect();
   if(before.run!==run||before.source!==source||!stepsVerified(before.steps)||before.nextStep!==null)throw Error('RESOURCE_COMPLETION_ALL_STEPS_REQUIRED');
   const current=validateCurrent(await verifyCurrentState(before),source,before.steps);
   await journal.assertExecutor();const after=await journal.inspect();
   if(after.revision!==before.revision||resourceDigest(after.steps)!==resourceDigest(before.steps))throw Error('RESOURCE_COMPLETION_JOURNAL_CHANGED');
   const receipt={version:1,run,source,steps:before.steps,current},text=JSON.stringify(receipt),sha=resourceDigest(receipt),next={N:String(before.revision+1)};
   const values={':execution':{S:arn},':source':{S:source},':kind':{S:KIND},':executor':{S:executor},':previous':{N:String(before.revision)},':next':next,':holding':{S:'holding'},':verified':{S:'verified'},':false':{BOOL:false},':true':{BOOL:true},':steps':{S:JSON.stringify(before.steps)},':stepsSha':{S:resourceDigest(before.steps)},':receipt':{S:text},':receiptSha':{S:sha}};
   const input={TransactItems:[{Update:{TableName:TABLE,Key:{pk:{S:'run#'+run}},UpdateExpression:'SET resource_phase=:verified,release_requested=:true,resource_revision=:next,api_admission_restored=:true,consumer_admission_restored=:true,deployment_admission_restored=:true,resource_completion_receipt=:receipt,resource_completion_receipt_sha256=:receiptSha',ConditionExpression:'execution_arn=:execution AND source_sha=:source AND #kind=:kind AND resource_executor_sha256=:executor AND resource_phase=:holding AND release_requested=:false AND resource_revision=:previous AND resource_steps=:steps AND resource_steps_sha256=:stepsSha AND attribute_not_exists(resource_completion_receipt)',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:values}},{ConditionCheck:{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn=:execution AND #kind=:kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:KIND}}}}]};
   try{await aws('ddb','TransactWriteItems',input);}catch{const row=await read();if(row?.resource_revision?.N!==next.N||row.resource_completion_receipt?.S!==text||row.resource_completion_receipt_sha256?.S!==sha)throw Error('RESOURCE_COMPLETION_WRITE_UNCERTAIN');}
   const row=await read();if(row?.resource_revision?.N!==next.N||row.resource_completion_receipt?.S!==text||row.resource_completion_receipt_sha256?.S!==sha)throw Error('RESOURCE_COMPLETION_NOT_DURABLE');
   return completed(row);
  },
 };
}
module.exports={createResourceCompletion};
