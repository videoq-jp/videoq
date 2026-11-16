// Read-only completion observations. Secrets are neither fetched nor returned.
const {resourceDigest,RESOURCE_STEPS}=require('./d1-resource-journal.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
const {createConsumerControl}=require('./cutover-sqs-consumers.cjs');
const {createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
const TARGET={accountId:'12daec56fdba43f677f2766ee26a5a39',databaseId:'587bd210-6d9d-4f32-abb7-a490013e65d3',largeIndex:'videoq-prod-scenes-1536',smallIndex:'videoq-prod-scenes-768'};
function createResourceCurrentState({journal,plans,cloudflare,lambda,github,sourceFence,targetFence,smokeProof,readSmokeBuild}){
 if(typeof journal?.assertExecutor!=='function'||typeof journal?.inspect!=='function'||typeof plans?.load!=='function'||[cloudflare,lambda,github,sourceFence,targetFence,readSmokeBuild].some(value=>typeof value!=='function')||typeof smokeProof?.verify!=='function')throw Error('RESOURCE_CURRENT_CONTEXT_REQUIRED');
 return async function verifyCurrentState(before){
  await journal.assertExecutor();
  const state=await journal.inspect();
  if(state.nextStep!==null||state.steps.length!==RESOURCE_STEPS.length||state.steps.some(row=>row.state!=='verified')||resourceDigest(state)!==resourceDigest(before))throw Error('RESOURCE_CURRENT_COMPLETE_JOURNAL_REQUIRED');
  const names=['pause-api','resume-api','promote-bindings','pause-consumers','freeze-deployments','fence-source','verify-e2e'];
  const values=await Promise.all(names.map(name=>plans.load(name)));
  if(values.some(value=>!value))throw Error('RESOURCE_CURRENT_PRIVATE_PLANS_REQUIRED');
  const [paused,resumed,promotion,consumers,deployments,fence,e2e]=values;
  for(const [i,name] of names.entries())if(resourceDigest(values[i])!==state.steps.find(row=>row.step===name).planSha256)throw Error('RESOURCE_CURRENT_PLAN_CHANGED');
  if(paused.scope?.purpose!=='production'||resumed.account!==TARGET.accountId||resumed.worker!=='videoq-api'||resourceDigest(promotion.sourcePlan)!==resourceDigest(paused)||resumed.bindingsHash!==promotion.targetBindingsHash||resumed.settingsHash!==paused.settingsHash||resumed.originalTraffic!==paused.originalTraffic||fence.owner!==state.run)throw Error('RESOURCE_CURRENT_TARGET_HANDOFF_REQUIRED');
  const control=createApiTrafficControl(cloudflare),api=await control.observe({purpose:'production'});
  function apiSafe(value){
   if(value.state.traffic!==resumed.originalTraffic||value.state.bindingsHash!==resumed.bindingsHash||value.state.settingsHash!==resumed.settingsHash||value.version!==e2e.apiVersion||value.state.bindingsHash!==e2e.apiBindingsSha256)throw Error('RESOURCE_CURRENT_API_DRIFT');
   for(const [name,type,key,expected] of [['DB','d1','id',TARGET.databaseId],['SCENE_VECTORIZE_1536','vectorize','index_name',TARGET.largeIndex],['SCENE_VECTORIZE_768','vectorize','index_name',TARGET.smallIndex]]){
    const rows=value.settings.bindings.filter(row=>row.name===name);if(rows.length!==1||rows[0].type!==type||rows[0][key]!==expected||name==='DB'&&rows[0].database_id!==undefined&&rows[0].database_id!==expected)throw Error('RESOURCE_CURRENT_BINDING_REQUIRED');
   }
  }
  apiSafe(api);
  const [consumerState,deploymentState,sourceState,targetState,native]=await Promise.all([
   createConsumerControl(lambda).inspect(consumers),createDeploymentFreeze(github).inspectAdmission(deployments),sourceFence(fence),targetFence(fence),
   Promise.resolve().then(()=>readSmokeBuild(e2e)).then(arn=>smokeProof.verify(e2e.nativePlan,arn,resourceDigest(e2e))),
  ]);
  const expectedFences=Object.keys(fence.fenceTriggers??{}).sort();
  const validSource=expectedFences.length>0&&sourceState&&sourceState.total===expectedFences.length&&Array.isArray(sourceState.installed)&&resourceDigest([...sourceState.installed].sort())===resourceDigest(expectedFences);
  const validTarget=targetState&&targetState.total===sourceState?.total&&Array.isArray(targetState.installed)&&targetState.installed.length===0;
  if(consumerState.originalAdmissionRestored!==true||deploymentState.originalAdmissionRestored!==true||!validSource||!validTarget||native.receipt.run!==state.run||native.receipt.source!==state.source||native.receipt.verifyAiAnswers!==true||resourceDigest(native.receipt)!==native.receiptSha256)throw Error('RESOURCE_CURRENT_ADMISSIONS_OR_E2E_REQUIRED');
  const e2eSha=resourceDigest({nativeReceiptSha256:native.receiptSha256,apiVersion:e2e.apiVersion,apiBindingsSha256:e2e.apiBindingsSha256});
  if(state.steps.find(row=>row.step==='verify-e2e').receiptSha256!==e2eSha)throw Error('RESOURCE_CURRENT_NATIVE_STEP_CHANGED');
  await journal.assertExecutor();const after=await control.observe({purpose:'production'});apiSafe(after);
  if(after.version!==api.version||resourceDigest(await journal.inspect())!==resourceDigest(before))throw Error('RESOURCE_CURRENT_CHANGED_DURING_PROBE');
  return{apiAdmissionRestored:true,consumerAdmissionRestored:true,deploymentAdmissionRestored:true,sourceFenced:true,targetUnfenced:true,...TARGET,
   apiVersion:api.version,smokeBuildArn:native.receipt.buildArn,smokeSourceSha:native.receipt.source,smokeCompletedAt:native.receipt.completedAt,e2eStepReceiptSha256:e2eSha};
 };
}
module.exports={createResourceCurrentState};
