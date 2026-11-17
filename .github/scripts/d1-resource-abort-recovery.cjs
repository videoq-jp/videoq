// Reconciliation-first pre-promotion recovery. Abort intent plus the original
// immutable step plans authorize restoration; no new snapshot is inferred from
// partially changed admission state. Release stays conditional in the ASL.
const {resourceDigest}=require('./d1-resource-journal.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
const {createConsumerControl}=require('./cutover-sqs-consumers.cjs');
const {createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
const TABLE='videoq-db-maintenance-prod',KIND='d1-resource-hold';
const HEX=/^[a-f0-9]{64}$/;
function createResourceAbortRecovery({aws,journal,plans,cloudflare,lambda,github,sourceFence,run,source,executorToken,enabled=false}){
 if([aws,cloudflare,lambda,github].some(v=>typeof v!=='function')||['requestAbort','assertAbortExecutor'].some(k=>typeof journal?.[k]!=='function')||typeof plans?.load!=='function'||['inspect','remove','assertUnfenced'].some(k=>typeof sourceFence?.[k]!=='function')||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||!HEX.test(executorToken??''))throw Error('RESOURCE_ABORT_RECOVERY_CONTEXT_REQUIRED');
 const execution='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run,executor=resourceDigest({executorToken}),key={pk:{S:'run#'+run}};
 const read=async()=>(await aws('ddb','GetItem',{TableName:TABLE,Key:key,ConsistentRead:true})).Item;
 async function ownership(){const state=await journal.assertAbortExecutor();if(state.run!==run||state.source!==source||state.steps.some(v=>v.step==='promote-bindings'))throw Error('RESOURCE_ABORT_PREPROMOTION_REQUIRED');return state;}
 function historical(row){
  if(row?.resource_phase?.S!=='aborted')return null;
  let receipt;try{receipt=JSON.parse(row.resource_completion_receipt.S);}catch{throw Error('RESOURCE_ABORT_COMPLETION_CORRUPT');}
  if(row.execution_arn?.S!==execution||row.kind?.S!==KIND||row.source_sha?.S!==source||row.resource_executor_sha256?.S!==executor||row.resource_abort_requested?.BOOL!==true||row.release_requested?.BOOL!==true||['api_admission_restored','consumer_admission_restored','deployment_admission_restored'].some(k=>row[k]?.BOOL!==true)||receipt.version!==1||receipt.kind!=='pre-promotion-abort'||receipt.run!==run||receipt.source!==source||receipt.executorSha256!==executor||receipt.sourceUnfenced!==true||receipt.apiAdmissionRestored!==true||receipt.consumerAdmissionRestored!==true||receipt.deploymentAdmissionRestored!==true||!HEX.test(receipt.sourceFenceSha256??'')||!HEX.test(receipt.apiSha256??'')||!Array.isArray(receipt.steps)||receipt.steps.some(v=>v.step==='promote-bindings')||JSON.stringify(receipt.steps)!==row.resource_steps?.S||resourceDigest(receipt.steps)!==row.resource_steps_sha256?.S||resourceDigest(receipt)!==row.resource_completion_receipt_sha256?.S)throw Error('RESOURCE_ABORT_COMPLETION_CORRUPT');
  return{status:'abort-release-requested',receiptSha256:row.resource_completion_receipt_sha256.S};
 }
 async function originals(state){
  const result={};for(const step of ['freeze-deployments','pause-api','pause-consumers','fence-source']){
   const entry=state.steps.find(v=>v.step===step);if(!entry)continue;
   const plan=await plans.load(step);if(!plan||resourceDigest(plan)!==entry.planSha256)throw Error('RESOURCE_ABORT_ORIGINAL_PLAN_REQUIRED');if(step==='fence-source'&&plan.owner!==run||step==='pause-consumers'&&plan.scope?.purpose!=='production')throw Error('RESOURCE_ABORT_ORIGINAL_PLAN_REQUIRED');result[step]=plan;
  }return result;
 }
 function control(original){return createApiTrafficControl(cloudflare,{assertOwnership:ownership,assertRestoreSafe:async()=>{await ownership();if(!original)throw Error('RESOURCE_ABORT_ORIGINAL_PLAN_REQUIRED');await unfenced(original['fence-source']);await api(original['pause-api']);}});}
 async function api(original){
  const value=await control().observe({purpose:'production'});
  const expected=[['DB','d1','id','e57d0931-18cb-4f00-ae7f-b0068030fb04'],['SCENE_VECTORIZE_1536','vectorize','index_name','videoq-scenes-migration-v3-1536'],['SCENE_VECTORIZE_768','vectorize','index_name','videoq-scenes-migration-v3-768']];
  for(const [name,type,field,wanted] of expected){const rows=value.settings.bindings.filter(v=>v.name===name);if(rows.length!==1||rows[0].type!==type||rows[0][field]!==wanted||name==='DB'&&rows[0].database_id!==undefined&&rows[0].database_id!==wanted)throw Error('RESOURCE_ABORT_SOURCE_BINDINGS_REQUIRED');}
  if(original&&(original.scope?.purpose!=='production'||original.account!=='12daec56fdba43f677f2766ee26a5a39'||original.worker!=='videoq-api'||value.state.bindingsHash!==original.bindingsHash||value.state.settingsHash!==original.settingsHash||![original.originalTraffic,'paused'].includes(value.state.traffic)))throw Error('RESOURCE_ABORT_API_DRIFT');
  if(!original&&![null,'running'].includes(value.state.traffic))throw Error('RESOURCE_ABORT_UNPLANNED_API_PAUSE');
  return value;
 }
 async function unfenced(original){const sha=await sourceFence.assertUnfenced(original??null);if(!HEX.test(sha??''))throw Error('RESOURCE_ABORT_SOURCE_UNFENCED_PROOF_REQUIRED');return sha;}
 async function backendSafe(original){await ownership();await unfenced(original['fence-source']);const state=await api(original['pause-api']);if(original['pause-api']&&state.state.traffic!==original['pause-api'].originalTraffic)throw Error('RESOURCE_ABORT_API_STILL_PAUSED');return state;}
 async function finish(state,original){
  const beforeApi=await backendSafe(original),fenceSha=await unfenced(original['fence-source']);
  if(original['pause-consumers']&&(await createConsumerControl(lambda).inspect(original['pause-consumers'])).originalAdmissionRestored!==true)throw Error('RESOURCE_ABORT_CONSUMERS_NOT_RESTORED');
  if(original['freeze-deployments']&&(await createDeploymentFreeze(github).inspectAdmission(original['freeze-deployments'])).originalAdmissionRestored!==true)throw Error('RESOURCE_ABORT_DEPLOYMENTS_NOT_RESTORED');
  const after=await ownership(),afterApi=await api(original['pause-api']);if(after.revision!==state.revision||resourceDigest(after.steps)!==resourceDigest(state.steps)||resourceDigest(beforeApi)!==resourceDigest(afterApi))throw Error('RESOURCE_ABORT_CHANGED_DURING_COMPLETION');
  const receipt={version:1,kind:'pre-promotion-abort',run,source,executorSha256:executor,steps:state.steps,sourceUnfenced:true,sourceFenceSha256:fenceSha,apiSha256:resourceDigest(afterApi),apiAdmissionRestored:true,consumerAdmissionRestored:true,deploymentAdmissionRestored:true},text=JSON.stringify(receipt),sha=resourceDigest(receipt),next={N:String(state.revision+1)};
  const values={':execution':{S:execution},':kind':{S:KIND},':source':{S:source},':executor':{S:executor},':holding':{S:'holding'},':aborted':{S:'aborted'},':true':{BOOL:true},':false':{BOOL:false},':previous':{N:String(state.revision)},':next':next,':steps':{S:JSON.stringify(state.steps)},':stepsSha':{S:resourceDigest(state.steps)},':receipt':{S:text},':receiptSha':{S:sha}};
  const input={TransactItems:[{Update:{TableName:TABLE,Key:key,UpdateExpression:'SET resource_phase=:aborted,release_requested=:true,resource_revision=:next,api_admission_restored=:true,consumer_admission_restored=:true,deployment_admission_restored=:true,resource_completion_receipt=:receipt,resource_completion_receipt_sha256=:receiptSha,resource_steps=:steps,resource_steps_sha256=:stepsSha',ConditionExpression:'execution_arn=:execution AND #kind=:kind AND source_sha=:source AND resource_executor_sha256=:executor AND resource_abort_requested=:true AND resource_phase=:holding AND release_requested=:false AND resource_revision=:previous AND attribute_not_exists(resource_completion_receipt)',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:values}},{ConditionCheck:{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn=:execution AND #kind=:kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:execution},':kind':{S:KIND}}}}]};
  try{await aws('ddb','TransactWriteItems',input);}catch{const row=await read();if(row?.resource_revision?.N!==next.N||row.resource_completion_receipt?.S!==text)throw Error('RESOURCE_ABORT_COMPLETION_UNCERTAIN');}
  const row=await read();if(row?.resource_revision?.N!==next.N||row.resource_completion_receipt?.S!==text)throw Error('RESOURCE_ABORT_COMPLETION_NOT_DURABLE');return historical(row);
 }
 return{async advance(){
  try{
  if(!enabled)throw Error('RESOURCE_ABORT_RECOVERY_DISABLED');
  const completed=historical(await read());if(completed)return completed;
  await journal.requestAbort();const state=await ownership(),original=await originals(state),current=await api(original['pause-api']);
  if(original['fence-source']){
   const observed=await sourceFence.inspect(original['fence-source']);
   if(!Array.isArray(observed.installed)||!Number.isSafeInteger(observed.total)||observed.total<=0||observed.installed.length>observed.total)throw Error('RESOURCE_ABORT_FENCE_OBSERVATION_REQUIRED');
   if(observed.installed.length){
    if(current.state.traffic!=='paused')throw Error('RESOURCE_ABORT_SOURCE_NOT_ISOLATED');
    await ownership();await sourceFence.remove(original['fence-source']);await ownership();await unfenced(original['fence-source']);return{status:'pending',restored:'source-fence'};
   }
  }
  await unfenced(original['fence-source']);
  if(original['pause-api']&&current.state.traffic!==original['pause-api'].originalTraffic){
   await control(original).change(original['pause-api'],false);await ownership();return{status:'pending',restored:'api'};
  }
  if(original['pause-consumers']){
   const consumer=createConsumerControl(lambda,{assertOwnership:async()=>{await backendSafe(original);}});
   if(!(await consumer.inspect(original['pause-consumers'])).originalAdmissionRestored){await consumer.resume(original['pause-consumers']);await ownership();return{status:'pending',restored:'consumers'};}
  }
  if(original['freeze-deployments']){
   const freeze=createDeploymentFreeze(github,{assertOwnership:async()=>{await backendSafe(original);if(original['pause-consumers']&&(await createConsumerControl(lambda).inspect(original['pause-consumers'])).originalAdmissionRestored!==true)throw Error('RESOURCE_ABORT_CONSUMERS_NOT_RESTORED');}});
   if(!(await freeze.inspectAdmission(original['freeze-deployments'])).originalAdmissionRestored){await freeze.restore(original['freeze-deployments']);await ownership();return{status:'pending',restored:'deployments'};}
  }
  return await finish(state,original);
  }catch(error){if(/^RESOURCE_[A-Z0-9_]+$/.test(error?.message??''))throw error;throw Error('RESOURCE_ABORT_RECOVERY_FAILED');}
 }};
}
module.exports={createResourceAbortRecovery};
