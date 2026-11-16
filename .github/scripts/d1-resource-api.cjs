// Traffic admission only; late old Worker/DO requests require the D1 write fence.
const {createApiTrafficControl,validateApiTrafficPlan}=require('./cutover-api-traffic.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
function createResourceApiAdapters({request,plans,assertOwnership,verifiedBackendHandoff}){
 if(typeof request!=='function'||typeof plans?.load!=='function'||typeof assertOwnership!=='function'||typeof verifiedBackendHandoff!=='function')throw Error('RESOURCE_API_CONTEXT_REQUIRED');
 async function original(){const plan=validateApiTrafficPlan(await plans.load('pause-api'));if(plan.scope.purpose!=='production')throw Error('RESOURCE_API_PRODUCTION_REQUIRED');return plan;}
 async function handoff(plan,allowOriginal=false){
  const source=await original();
  if(plan.operationId!==source.operationId||plan.account!==source.account||plan.worker!==source.worker||plan.originalTraffic!==source.originalTraffic||plan.settingsHash!==source.settingsHash||resourceDigest(plan.scope)!==resourceDigest(source.scope))throw Error('RESOURCE_API_ORIGINAL_PLAN_REQUIRED');
  const expected=await verifiedBackendHandoff({originalPlan:source});
  if(!/^[a-f0-9]{64}$/.test(expected?.bindingsHash??'')||!allowOriginal&&expected.bindingsHash!==plan.bindingsHash)throw Error('RESOURCE_API_VERIFIED_HANDOFF_REQUIRED');
  return expected.bindingsHash;
 }
 function control(owned=assertOwnership){return createApiTrafficControl(request,{assertOwnership:owned,assertRestoreSafe:plan=>handoff(plan)});}
 const receipt=(step,plan)=>({state:'applied',receiptSha256:resourceDigest({step,planSha256:resourceDigest(plan),admissionVerified:true,inFlightDrainProven:false})});
 return{
  'pause-api':{
   prepare:()=>control().prepare({purpose:'production'}),
   async probe(plan){if(resourceDigest(await original())!==resourceDigest(plan))throw Error('RESOURCE_API_ORIGINAL_PLAN_REQUIRED');const state=await control().inspect(plan);return state.trafficPaused?receipt('pause-api',plan):{state:'not-applied'};},
   async apply(plan,context){if(resourceDigest(await original())!==resourceDigest(plan))throw Error('RESOURCE_API_ORIGINAL_PLAN_REQUIRED');await control(context.assertOwnership).change(plan,true);},
  },
  'resume-api':{
   async prepare(){const source=await original(),expected=await handoff(source,true);return control().prepareRestore(source,expected);},
   async probe(plan){validateApiTrafficPlan(plan);if(await handoff(plan)!==plan.bindingsHash)throw Error('RESOURCE_API_VERIFIED_HANDOFF_REQUIRED');const state=await control().inspect(plan);return state.originalTrafficRestored?receipt('resume-api',plan):{state:'not-applied'};},
   async apply(plan,context){if(await handoff(plan)!==plan.bindingsHash)throw Error('RESOURCE_API_VERIFIED_HANDOFF_REQUIRED');await control(context.assertOwnership).change(plan,false);},
  },
 };
}
module.exports={createResourceApiAdapters};
