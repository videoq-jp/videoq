// Concrete GitHub workflow adapter. No transport or credentials are loaded here.
// GitHub admission is only one fence; AWS builds and D1 writers need other steps.
const {createDeploymentFreeze,validateDeploymentFreezePlan}=require('./cutover-deployment-freeze.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
function createResourceDeploymentAdapters({request,plans}){
 if(typeof request!=='function'||typeof plans?.load!=='function')throw Error('RESOURCE_DEPLOYMENT_CONTEXT_REQUIRED');
 const control=createDeploymentFreeze(request);
 const receipt=(step,plan)=>({state:'applied',receiptSha256:resourceDigest({step,planSha256:resourceDigest(plan),verified:true})});
 async function original(plan){
  validateDeploymentFreezePlan(plan);
  const saved=await plans.load('freeze-deployments');
  if(!saved||resourceDigest(saved)!==resourceDigest(plan))throw Error('RESOURCE_DEPLOYMENT_ORIGINAL_PLAN_REQUIRED');
 }
 return{
  'freeze-deployments':{
   prepare:()=>control.prepare(),
   async probe(plan){
    await original(plan);const state=await control.inspect(plan);
    if(!state.admissionFrozen)return{state:'not-applied'};
    // Already accepted runs must finish; freezing again does not drain them.
    if(!state.githubRunsDrained)return{state:'unknown'};
    return receipt('freeze-deployments',plan);
   },
   async apply(plan,{assertOwnership}){
    await original(plan);
    await createDeploymentFreeze(request,{assertOwnership}).freeze(plan);
   },
  },
  'restore-deployments':{
   async prepare(){const plan=await plans.load('freeze-deployments');await original(plan);return plan;},
   async probe(plan){await original(plan);return(await control.inspectAdmission(plan)).originalAdmissionRestored?receipt('restore-deployments',plan):{state:'not-applied'};},
   async apply(plan,{assertOwnership}){await original(plan);await createDeploymentFreeze(request,{assertOwnership}).restore(plan);},
  },
 };
}
module.exports={createResourceDeploymentAdapters};
