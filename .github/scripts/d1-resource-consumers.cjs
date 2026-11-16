// SQS admission adapter only. Running/direct Lambda invocations can still write;
// the later D1 source write fence is mandatory. No app configuration/secrets read.
const {createConsumerControl,validateConsumerPlan}=require('./cutover-sqs-consumers.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
function createResourceConsumerAdapters({aws,plans,assertBackendSafe}){
 if(typeof aws!=='function'||typeof plans?.load!=='function'||typeof assertBackendSafe!=='function')throw Error('RESOURCE_CONSUMER_CONTEXT_REQUIRED');
 const control=createConsumerControl(aws);
 async function original(plan){
  validateConsumerPlan(plan);if(plan.scope.purpose!=='production')throw Error('RESOURCE_CONSUMER_PRODUCTION_REQUIRED');
  const saved=await plans.load('pause-consumers');
  if(!saved||resourceDigest(saved)!==resourceDigest(plan))throw Error('RESOURCE_CONSUMER_ORIGINAL_PLAN_REQUIRED');
 }
 const receipt=(step,plan)=>({state:'applied',receiptSha256:resourceDigest({step,planSha256:resourceDigest(plan),admissionVerified:true,inFlightDrainProven:false})});
 function adapter(resume){
  const step=resume?'resume-consumers':'pause-consumers';
  return{
   async prepare(){if(!resume)return control.prepare({purpose:'production'});const plan=await plans.load('pause-consumers');await original(plan);return plan;},
   async probe(plan){
    await original(plan);await assertBackendSafe({resume,plan});
    const state=await control.inspect(plan),allowed=resume?['Enabled','Enabling','Disabled']:['Enabled','Disabling','Disabled'];
    if(state.states.some((row,i)=>!allowed.includes(row.state)||!plan.consumers[i].wasEnabled&&row.state!=='Disabled'))throw Error('RESOURCE_CONSUMER_STATE_DRIFT');
    if(resume?state.originalAdmissionRestored:state.admissionPaused)return receipt(step,plan);
    if(state.states.some(row=>['Enabling','Disabling'].includes(row.state)))return{state:'unknown'};
    return{state:'not-applied'};
   },
   async apply(plan,{assertOwnership}){
    await original(plan);
    const owned=async()=>{await assertOwnership();await assertBackendSafe({resume,plan});};
    await createConsumerControl(aws,{assertOwnership:owned})[resume?'resume':'pause'](plan);
   },
  };
 }
 return{'pause-consumers':adapter(false),'resume-consumers':adapter(true)};
}
module.exports={createResourceConsumerAdapters};
