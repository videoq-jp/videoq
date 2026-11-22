const {createBackgroundQueueAdmission}=require('./background-queue-admission.cjs');
const {createBackgroundWorkflowAdmission}=require('./background-workflow-admission.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
// Consumer wall time is at most 15 minutes. Add one minute before observing
// Workflows so a handler delivered just before pause can no longer start one.
const DRAIN_MS=16*60*1000;
function backgroundBindingsPresent(production,settings){
 const names=['ACCOUNT_JOBS','SEARCH_JOBS','SEARCH_INDEX_WORKFLOW'];
 return names.some(name=>settings.bindings?.some(row=>row.name===name))||
  (production.queues?.consumers?.length??0)>0||(production.workflows?.length??0)>0||
  ['ACCOUNT_JOB_BACKEND','SEARCH_JOB_BACKEND'].some(name=>production.vars?.[name]==='cloudflare'||settings.bindings?.some(row=>row.name===name&&row.text==='cloudflare'));
}
function createBackgroundMigrationReadTransport({token,fetcher=fetch}){
 if(typeof token!=='string'||token.length<20||token.length>4096||/[\r\n\0]/.test(token))throw Error('INVALID_BACKGROUND_MIGRATION_CREDENTIAL');
 return async(method,path)=>{
  const prefix=`accounts/${ACCOUNT}/`,queue=/^queues(?:\?page=[1-9]\d*&per_page=500|\/[a-f0-9]{32})$/;
  const workflow=/^workflows\/videoq-search-index-prod\/instances\?per_page=100&direction=asc(?:&cursor=[A-Za-z0-9%+_.~-]+)?$/;
  if(method!=='GET'||!path.startsWith(prefix)||![queue,workflow].some(pattern=>pattern.test(path.slice(prefix.length))))throw Error('BACKGROUND_MIGRATION_READ_SCOPE_REQUIRED');
  const response=await fetcher('https://api.cloudflare.com/client/v4/'+path,{method:'GET',headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok||!response.body)throw Error('BACKGROUND_MIGRATION_READ_FAILED');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024)throw Error('BACKGROUND_MIGRATION_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('BACKGROUND_MIGRATION_RESPONSE_INVALID');}
  if(data.success!==true)throw Error('BACKGROUND_MIGRATION_READ_FAILED');return data;
 };
}
async function assertBackgroundMigrationFence({production,settings,request,now=Date.now}){
 if(!backgroundBindingsPresent(production,settings))return{required:false};
 if(settings.bindings?.find(row=>row.name==='MIGRATION_TRAFFIC_STATE')?.text!=='paused')throw Error('BACKGROUND_MIGRATION_API_PAUSE_REQUIRED');
 const queueRequest=async(method,path)=>(await request(method,path)).result;
 const queues=createBackgroundQueueAdmission(queueRequest),plan=await queues.prepare();
 if(!(await queues.inspect(plan)).admissionPaused)throw Error('BACKGROUND_MIGRATION_QUEUE_PAUSE_REQUIRED');
 for(const row of plan.queues){
  const current=await queueRequest('GET',`accounts/${ACCOUNT}/queues/${row.id}`),modified=Date.parse(current.modified_on);
  if(current.queue_id!==row.id||current.queue_name!==row.name||current.settings?.delivery_paused!==true||!Number.isFinite(modified)||!Number.isFinite(now())||now()-modified<DRAIN_MS)throw Error('BACKGROUND_MIGRATION_QUEUE_DRAIN_REQUIRED');
 }
 const workflows=createBackgroundWorkflowAdmission(request,{assertAdmissionClosed:async()=>{
  if(!(await queues.inspect(plan)).admissionPaused)throw Error('BACKGROUND_MIGRATION_QUEUE_PAUSE_CHANGED');
 }}),workflowPlan=await workflows.prepare();
 if(!(await workflows.inspect(workflowPlan)).executionPaused)throw Error('BACKGROUND_MIGRATION_WORKFLOW_PAUSE_REQUIRED');
 // Recheck identities/settings after the Workflow observation too.
 if(!(await queues.inspect(plan)).admissionPaused)throw Error('BACKGROUND_MIGRATION_QUEUE_PAUSE_CHANGED');
 return{required:true,queueAdmissionPaused:true,consumerDrainWindowElapsed:true,workflowsPaused:true};
}
module.exports={assertBackgroundMigrationFence,createBackgroundMigrationReadTransport,backgroundBindingsPresent};
