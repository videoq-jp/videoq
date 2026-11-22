// One non-blocking reconciliation per call. Caller must hold an exclusive
// maintenance lease/local operation lock and supply a durable, create-only store.
// No credentials, lease acquisition, DB mutation or traffic reopening lives here.
// Schema migration closes API admission. The verification-only caller instead
// proves both native producers remain routed to SQS and never executes DDL.
const {resourceDigest}=require('./d1-resource-journal.cjs');
const {createBackgroundQueueAdmission}=require('./background-queue-admission.cjs');
const {createBackgroundWorkflowAdmission}=require('./background-workflow-admission.cjs');
const DRAIN_MS=16*60*1000;
function createBackgroundMaintenance({request,plans,assertOwnership,assertProducerAdmissionClosed,assertApiPaused=assertProducerAdmissionClosed,assertRestoreSafe,now=Date.now}){
 if(typeof request!=='function'||typeof plans?.load!=='function'||typeof plans?.save!=='function'||[assertOwnership,assertApiPaused,assertRestoreSafe,now].some(value=>typeof value!=='function'))throw Error('BACKGROUND_MAINTENANCE_CONTEXT_REQUIRED');
 const owned=async()=>{await assertOwnership();await assertApiPaused();};
 async function save(key,value){
  await owned();await plans.save(key,value);
  if(resourceDigest(await plans.load(key))!==resourceDigest(value))throw Error('BACKGROUND_MAINTENANCE_PLAN_NOT_DURABLE');
  await owned();return value;
 }
 const queues=createBackgroundQueueAdmission(async(method,path,body)=>(await request(method,path,body)).result,{assertOwnership:owned,assertRestoreSafe});
 let queuePlan;
 const closed=async()=>{
  await owned();if(!queuePlan||!(await queues.inspect(queuePlan)).admissionPaused)throw Error('BACKGROUND_MAINTENANCE_QUEUES_NOT_PAUSED');
 };
 const workflows=createBackgroundWorkflowAdmission(request,{assertOwnership:owned,assertAdmissionClosed:closed,assertRestoreSafe});
 function timestamp(){const value=now();if(!Number.isSafeInteger(value)||value<0)throw Error('BACKGROUND_MAINTENANCE_CLOCK_REQUIRED');return value;}
 async function load(){
  await owned();queuePlan=await plans.load('background-queues');return queuePlan;
 }
 return{
  async pause(){
   await load();
   if(await plans.load('background-restore'))throw Error('BACKGROUND_MAINTENANCE_RESTORE_ALREADY_STARTED');
   if(!queuePlan)queuePlan=await save('background-queues',await queues.prepare());
   await queues.change(queuePlan,true);await closed();
   let drain=await plans.load('background-drain');
   if(!drain)drain=await save('background-drain',{queuePlanSha256:resourceDigest(queuePlan),pausedObservedAt:timestamp()});
   if(drain.queuePlanSha256!==resourceDigest(queuePlan)||!Number.isSafeInteger(drain.pausedObservedAt)||drain.pausedObservedAt<0||timestamp()<drain.pausedObservedAt)throw Error('BACKGROUND_MAINTENANCE_DRAIN_RECORD_INVALID');
   if(timestamp()-drain.pausedObservedAt<DRAIN_MS)return{status:'draining-consumers',retryAfterMs:DRAIN_MS-(timestamp()-drain.pausedObservedAt)};
   await closed();let workflowPlan=await plans.load('background-workflows');
   if(!workflowPlan)workflowPlan=await save('background-workflows',await workflows.prepare());
   const observed=await workflows.change(workflowPlan,true);await closed();
   return{status:observed.executionPaused?'paused':'pausing-workflows'};
  },
  async restore(){
   await load();await assertRestoreSafe();
   if(!queuePlan)throw Error('BACKGROUND_MAINTENANCE_ORIGINAL_PLAN_REQUIRED');
   // Persist restore intent before any resume. From this point a caller cannot
   // invoke pause and accidentally re-baseline the same maintenance operation.
   const expected={queuePlanSha256:resourceDigest(queuePlan)};
   let intent=await plans.load('background-restore');
   if(!intent)intent=await save('background-restore',expected);
   if(resourceDigest(intent)!==resourceDigest(expected))throw Error('BACKGROUND_MAINTENANCE_RESTORE_RECORD_INVALID');
   const workflowPlan=await plans.load('background-workflows');
   if(workflowPlan){
    // Resumed instances may run only after the caller's DB-safe assertion.
    // Keep queues closed until every owned Workflow resume is reconciled.
    const observed=await workflows.inspect(workflowPlan);
    const state=observed.originalExecutionRestored?observed:await workflows.change(workflowPlan,false);
    if(!state.originalExecutionRestored)throw Error('BACKGROUND_MAINTENANCE_WORKFLOW_RESTORE_PENDING');
   }
   const result=await queues.change(queuePlan,false);await owned();await assertRestoreSafe();
   if(!result.originalAdmissionRestored)throw Error('BACKGROUND_MAINTENANCE_QUEUE_RESTORE_PENDING');
   return{status:'restored',apiTrafficRestored:false};
  },
 };
}
module.exports={createBackgroundMaintenance};
