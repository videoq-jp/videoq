// Call only after native producer/queue admission is closed and delivered queue handlers
// have drained. Persist prepare() before change(). Never terminate/restart work.
const {randomUUID}=require('node:crypto');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39',WORKFLOW='videoq-search-index-prod';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const TERMINAL=new Set(['complete','errored','terminated']);
const ACTIVE=new Set(['queued','running','waiting','rollingBack']);
const STATES=new Set([...TERMINAL,...ACTIVE,'paused','waitingForPause']);
function checked(plan){
 if(plan?.version!==1||plan.account!==ACCOUNT||plan.workflow!==WORKFLOW||!UUID.test(plan.operationId??'')||!Array.isArray(plan.instances)||plan.instances.length>100000||new Set(plan.instances.map(row=>row.id)).size!==plan.instances.length||plan.instances.some(row=>typeof row.id!=='string'||!/^[\w-]{1,100}$/.test(row.id)||!UUID.test(row.versionId??'')||typeof row.originalPaused!=='boolean'))throw Error('INVALID_BACKGROUND_WORKFLOW_PLAN');
 return plan;
}
function createBackgroundWorkflowAdmission(request,{assertOwnership=async()=>{throw Error('BACKGROUND_WORKFLOW_OWNERSHIP_REQUIRED');},assertAdmissionClosed=async()=>{throw Error('BACKGROUND_WORKFLOW_ADMISSION_FENCE_REQUIRED');},assertRestoreSafe=async()=>{throw Error('BACKGROUND_WORKFLOW_RESTORE_FENCE_REQUIRED');}}={}){
 const base=`accounts/${ACCOUNT}/workflows/${WORKFLOW}/instances`;
 async function list(){
  const result=[],seen=new Set();let cursor;
  for(let page=0;page<10000;page++){
   const query=new URLSearchParams({per_page:'100',direction:'asc'});if(cursor)query.set('cursor',cursor);
   // This transport returns the envelope to preserve cursor metadata. Instance
   // list contains execution metadata only, unlike GET instance params/output.
   const response=await request('GET',base+'?'+query),rows=response?.result;
   if(response?.success!==true||!Array.isArray(rows)||rows.length>100||rows.some(row=>typeof row.id!=='string'||!/^[\w-]{1,100}$/.test(row.id)||!UUID.test(row.version_id??'')||!STATES.has(row.status)))throw Error('INVALID_BACKGROUND_WORKFLOW_LIST');
   for(const row of rows){if(seen.has(row.id))throw Error('BACKGROUND_WORKFLOW_LIST_CHANGED');seen.add(row.id);result.push(row);}
   const next=response.result_info?.cursor;
   if(next===undefined||next===null||next==='')return result;
   if(typeof next!=='string'||next===cursor||next.length>4096)throw Error('INVALID_BACKGROUND_WORKFLOW_CURSOR');
   cursor=next;
  }
  throw Error('BACKGROUND_WORKFLOW_PAGINATION_LIMIT');
 }
 async function observe(plan){
  checked(plan);const rows=await list(),known=new Map(plan.instances.map(row=>[row.id,row]));
  if(rows.some(row=>!TERMINAL.has(row.status)&&!known.has(row.id)))throw Error('BACKGROUND_WORKFLOW_NEW_INSTANCE');
  return plan.instances.map(row=>{
   const current=rows.find(value=>value.id===row.id);
   // Missing instances are not interpreted as completed; expiry needs explicit
   // reconciliation rather than guessing that a writer is no longer live.
   if(!current||current.version_id!==row.versionId)throw Error('BACKGROUND_WORKFLOW_IDENTITY_CHANGED');
   if(row.originalPaused&&current.status!=='paused'&&!TERMINAL.has(current.status))throw Error('BACKGROUND_WORKFLOW_ORIGINAL_PAUSE_CHANGED');
   return current;
  });
 }
 async function owned(plan,resume=false){await assertOwnership(plan);await assertAdmissionClosed(plan);if(resume)await assertRestoreSafe(plan);}
 return{
  async prepare(){
   await assertAdmissionClosed();const rows=await list();await assertAdmissionClosed();
   if(rows.some(row=>row.status==='waitingForPause'))throw Error('BACKGROUND_WORKFLOW_UNOWNED_PAUSE');
   return checked({version:1,account:ACCOUNT,workflow:WORKFLOW,operationId:randomUUID(),instances:rows.filter(row=>!TERMINAL.has(row.status)).map(row=>({id:row.id,versionId:row.version_id,originalPaused:row.status==='paused'}))});
  },
  async inspect(plan){
   const rows=await observe(plan);
   return{executionPaused:rows.every(row=>row.status==='paused'||TERMINAL.has(row.status)),originalExecutionRestored:rows.every((row,i)=>TERMINAL.has(row.status)||(plan.instances[i].originalPaused?row.status==='paused':ACTIVE.has(row.status))),waitingForPause:rows.some(row=>row.status==='waitingForPause')};
  },
  async change(plan,pause){
   checked(plan);if(typeof pause!=='boolean')throw Error('INVALID_BACKGROUND_WORKFLOW_OPERATION');
   await owned(plan,!pause);await observe(plan);
   for(let i=0;i<plan.instances.length;i++){
    await owned(plan,!pause);const current=(await observe(plan))[i],original=plan.instances[i];
    if(TERMINAL.has(current.status)||original.originalPaused||pause&&['paused','waitingForPause'].includes(current.status)||!pause&&ACTIVE.has(current.status))continue;
    if(!pause&&current.status==='waitingForPause')throw Error('BACKGROUND_WORKFLOW_PAUSE_NOT_FINISHED');
    await owned(plan,!pause);let failure;
    try{await request('PATCH',`${base}/${encodeURIComponent(original.id)}/status`,{status:pause?'pause':'resume'});}catch(error){failure=error;}
    const after=(await observe(plan))[i];
    if(!TERMINAL.has(after.status)&&!(pause?['paused','waitingForPause'].includes(after.status):ACTIVE.has(after.status))){if(failure)throw failure;throw Error('BACKGROUND_WORKFLOW_UPDATE_INCOMPLETE');}
   }
   await owned(plan,!pause);return this.inspect(plan);
  },
 };
}
module.exports={createBackgroundWorkflowAdmission,validateBackgroundWorkflowPlan:checked};
