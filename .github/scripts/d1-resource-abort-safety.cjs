// Fresh pre-promotion source-unfence proof. Requires durable abort mode; normal
// coordinator operations are excluded by the ownership journal at that point.
const {resourceDigest}=require('./d1-resource-journal.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
const {createConsumerControl}=require('./cutover-sqs-consumers.cjs');
const {createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
function createResourceAbortSourceSafety({journal,plans,cloudflare,lambda,github,assertRecoveryIsolation}){
 if(typeof journal?.assertAbortExecutor!=='function'||typeof plans?.load!=='function'||[cloudflare,lambda,github,assertRecoveryIsolation].some(v=>typeof v!=='function'))throw Error('RESOURCE_ABORT_SAFETY_CONTEXT_REQUIRED');
 const apiControl=createApiTrafficControl(cloudflare);
 return async function assertSourceSafe(input){
  const fence=input?.plan,state=await journal.assertAbortExecutor();
  const names=['fence-source','pause-api','pause-consumers','freeze-deployments'],values=await Promise.all(names.map(k=>plans.load(k)));
  if(!fence||fence.owner!==state.run||values.some(v=>!v)||resourceDigest(values[0])!==resourceDigest(fence)||names.some((name,i)=>state.steps.find(v=>v.step===name)?.planSha256!==resourceDigest(values[i])))throw Error('RESOURCE_ABORT_ORIGINAL_PLANS_REQUIRED');
  const [,paused,consumers,deployments]=values;
  if(paused.scope?.purpose!=='production'||paused.account!=='12daec56fdba43f677f2766ee26a5a39'||paused.worker!=='videoq-api'||consumers.scope?.purpose!=='production')throw Error('RESOURCE_ABORT_PRODUCTION_REQUIRED');
  await assertRecoveryIsolation();
  const api=await apiControl.observe({purpose:'production'}),[consumerState,deploymentState]=await Promise.all([createConsumerControl(lambda).inspect(consumers),createDeploymentFreeze(github).inspect(deployments)]);
  const source=api.settings.bindings.filter(v=>v.name==='DB');
  if(api.state.traffic!=='paused'||api.state.bindingsHash!==paused.bindingsHash||api.state.settingsHash!==paused.settingsHash||source.length!==1||source[0].type!=='d1'||source[0].id!=='e57d0931-18cb-4f00-ae7f-b0068030fb04'||source[0].database_id!==undefined&&source[0].database_id!==source[0].id||consumerState.admissionPaused!==true||deploymentState.admissionFrozen!==true||deploymentState.githubRunsDrained!==true)throw Error('RESOURCE_ABORT_SOURCE_NOT_ISOLATED');
  await assertRecoveryIsolation();await journal.assertAbortExecutor();
 };
}
module.exports={createResourceAbortSourceSafety};
