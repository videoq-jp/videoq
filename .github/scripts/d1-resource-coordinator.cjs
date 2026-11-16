// Sequential, reconciliation-first engine. Explicit reviewed adapters must
// implement every fixed operation; no production caller or credentials here.
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
function createResourceCoordinator({journal,adapters,plans,assertEnvironment,enabled=false}){
 if(!journal||!adapters||Object.keys(adapters).sort().join(',')!==[...RESOURCE_STEPS].sort().join(',')||RESOURCE_STEPS.some(step=>['prepare','probe','apply'].some(method=>typeof adapters[step]?.[method]!=='function'))||typeof plans?.load!=='function'||typeof plans?.save!=='function'||typeof assertEnvironment!=='function')throw Error('COMPLETE_RESOURCE_COORDINATOR_REQUIRED');
 function probeResult(value){
  if(!value||!['applied','not-applied','unknown'].includes(value.state)||Object.keys(value).sort().join(',')!==(value.state==='applied'?'receiptSha256,state':'state')||(value.state==='applied'&&!/^[a-f0-9]{64}$/.test(value.receiptSha256??'')))throw Error('INVALID_RESOURCE_STEP_OBSERVATION');
  return value;
 }
 return{
  async runNext(){
   try{
   if(!enabled)throw Error('RESOURCE_COORDINATOR_DISABLED');
   const state=await journal.inspect(),step=state.nextStep;
   if(step===null)return{status:'steps-verified',holdReleased:false};
   if(!RESOURCE_STEPS.includes(step))throw Error('INVALID_RESOURCE_COORDINATOR_STEP');
   const adapter=adapters[step];await assertEnvironment({step,stage:'before-plan'});
   let plan=await plans.load(step);
   if(plan===null){
    // An intent's original plan cannot be inferred from already changed state.
    if(state.steps.some(record=>record.step===step))throw Error('RESOURCE_PRIVATE_PLAN_REQUIRED');
    plan=await adapter.prepare();if(!plan||typeof plan!=='object'||Array.isArray(plan))throw Error('INVALID_RESOURCE_PRIVATE_PLAN');
    await plans.save(step,plan);const persisted=await plans.load(step);
    if(resourceDigest(persisted)!==resourceDigest(plan))throw Error('RESOURCE_PRIVATE_PLAN_NOT_DURABLE');
   }
   if(!plan||typeof plan!=='object'||Array.isArray(plan))throw Error('INVALID_RESOURCE_PRIVATE_PLAN');
   const pending={step,planSha256:resourceDigest(plan)},intent=await journal.begin(pending);
   if(intent.state==='verified')return{status:'already-verified',step};
   const owned=async()=>{await journal.assertPending(pending);await assertEnvironment({step,stage:'pending'});};
   await owned();let observed=probeResult(await adapter.probe(plan));
   if(observed.state==='unknown')throw Error('RESOURCE_STEP_RECONCILIATION_REQUIRED');
   if(observed.state==='not-applied'){
    await owned();
    // Never blindly repeat a mutation after losing its response. Exactly one
    // apply attempt per invocation; reconcile against authoritative readback.
    try{await adapter.apply(plan,{operationId:intent.operationId,assertOwnership:owned});}catch{ /* Provider error bodies must not escape. */ }
    await owned();observed=probeResult(await adapter.probe(plan));
   }
   if(observed.state!=='applied')throw Error(observed.state==='unknown'?'RESOURCE_STEP_RECONCILIATION_REQUIRED':'RESOURCE_STEP_NOT_APPLIED');
   await owned();await journal.verify({...pending,receiptSha256:observed.receiptSha256});
   return{status:'verified',step,holdReleased:false};
   }catch(error){
    if(/^(RESOURCE_|PRIVATE_RESOURCE_|INVALID_RESOURCE_|COMPLETE_RESOURCE_)[A-Z0-9_]+$/.test(error?.message??''))throw error;
    throw Error('RESOURCE_COORDINATOR_FAILED');
   }
  },
 };
}
module.exports={createResourceCoordinator};
