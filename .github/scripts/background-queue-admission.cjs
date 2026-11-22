// Admission only: a paused queue is NOT proof that delivered handlers or
// Workflows have stopped. The maintenance coordinator must establish that fence.
const {randomUUID}=require('node:crypto');
const {resourceDigest}=require('./d1-resource-journal.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
const NAMES=['videoq-account-prod','videoq-search-prod'];
const ID=/^[a-f0-9]{32}$/;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function snapshot(row,name,id){
 if(row?.queue_name!==name||!ID.test(row.queue_id??'')||id&&row.queue_id!==id||!row.settings||!Number.isSafeInteger(row.settings.message_retention_period)||row.settings.message_retention_period<345600||row.settings.delivery_paused!==undefined&&typeof row.settings.delivery_paused!=='boolean')throw Error('BACKGROUND_QUEUE_IDENTITY_OR_SETTINGS_DRIFT');
 if(!Array.isArray(row.consumers)||row.consumers.length!==1||row.consumers[0].type!=='worker'||(row.consumers[0].script_name??row.consumers[0].script)!=='videoq-api'||row.consumers[0].script_name!==undefined&&row.consumers[0].script!==undefined&&row.consumers[0].script_name!==row.consumers[0].script||row.consumers[0].dead_letter_queue!==name.replace('-prod','-dlq-prod'))throw Error('BACKGROUND_QUEUE_CONSUMER_DRIFT');
 const {delivery_paused,...settings}=row.settings;
 return{paused:delivery_paused??false,configurationHash:resourceDigest({settings,consumers:row.consumers})};
}
function checked(plan){
 if(plan?.version!==1||plan.account!==ACCOUNT||!UUID.test(plan.operationId??'')||!Array.isArray(plan.queues)||plan.queues.length!==2||plan.queues.some((row,i)=>row.name!==NAMES[i]||!ID.test(row.id??'')||typeof row.originalPaused!=='boolean'||!/^[a-f0-9]{64}$/.test(row.configurationHash??''))||new Set(plan.queues.map(row=>row.id)).size!==2)throw Error('INVALID_BACKGROUND_QUEUE_PLAN');
 return plan;
}
function createBackgroundQueueAdmission(request,{assertOwnership=async()=>{throw Error('BACKGROUND_QUEUE_OWNERSHIP_REQUIRED');},assertRestoreSafe=async()=>{throw Error('BACKGROUND_QUEUE_RESTORE_FENCE_REQUIRED');}}={}){
 const base=`accounts/${ACCOUNT}/queues`;
 async function observe(row){
  const state=snapshot(await request('GET',`${base}/${row.id}`),row.name,row.id);
  if(state.configurationHash!==row.configurationHash)throw Error('BACKGROUND_QUEUE_CONFIGURATION_CHANGED');
  return state;
 }
 return{
  async prepare(){
   const found=[];
   for(let page=1;;page++){
    const rows=await request('GET',`${base}?page=${page}&per_page=500`);
    if(!Array.isArray(rows)||rows.some(row=>typeof row?.queue_name!=='string'||!ID.test(row.queue_id??'')))throw Error('INVALID_BACKGROUND_QUEUE_LIST');
    found.push(...rows.filter(row=>NAMES.includes(row.queue_name)));
    if(rows.length<500)break;
    if(page>=10000)throw Error('BACKGROUND_QUEUE_PAGINATION_LIMIT');
   }
   const queues=[];
   for(const name of NAMES){
    const matches=found.filter(row=>row.queue_name===name);
    if(matches.length!==1)throw Error('BACKGROUND_QUEUE_SCOPE_REQUIRED');
    const id=matches[0].queue_id,state=snapshot(await request('GET',`${base}/${id}`),name,id);
    queues.push({name,id,originalPaused:state.paused,configurationHash:state.configurationHash});
   }
   return checked({version:1,account:ACCOUNT,operationId:randomUUID(),queues});
  },
  async inspect(plan){
   checked(plan);const states=[];
   for(const row of plan.queues)states.push(await observe(row));
   return{admissionPaused:states.every(row=>row.paused),originalAdmissionRestored:states.every((row,i)=>row.paused===plan.queues[i].originalPaused),inFlightDrainProven:false};
  },
  async change(plan,pause){
   checked(plan);if(typeof pause!=='boolean')throw Error('INVALID_BACKGROUND_QUEUE_OPERATION');
   const owned=async()=>{await assertOwnership(plan);if(!pause)await assertRestoreSafe(plan);};
   // Check every target before the first mutation; leave partial operations
   // recoverable from the persisted original plan after a transport failure.
   await owned();await this.inspect(plan);
   for(const row of plan.queues){
    await owned();const state=await observe(row),desired=pause||row.originalPaused;
    if(state.paused===desired)continue;
    await owned();let failure;
    try{await request('PATCH',`${base}/${row.id}`,{settings:{delivery_paused:desired}});}catch(error){failure=error;}
    // Never resend on a lost acknowledgement. A later coordinator retry first
    // observes the same queue and the same persisted operation.
    if((await observe(row)).paused!==desired){if(failure)throw failure;throw Error('BACKGROUND_QUEUE_UPDATE_INCOMPLETE');}
   }
   await owned();return this.inspect(plan);
  },
 };
}
module.exports={createBackgroundQueueAdmission,validateBackgroundQueuePlan:checked};
