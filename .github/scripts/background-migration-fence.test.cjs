const {test}=require('node:test'),assert=require('node:assert/strict');
const {assertBackgroundMigrationFence,createBackgroundMigrationReadTransport}=require('./background-migration-fence.cjs');
function fixture(){
 const now=Date.parse('2026-11-22T15:00:00Z');
 const queues=['account','search'].map((kind,i)=>({queue_id:String(i+1).repeat(32),queue_name:`videoq-${kind}-prod`,modified_on:new Date(now-17*60000).toISOString(),settings:{message_retention_period:345600,delivery_paused:true},consumers:[{type:'worker',script_name:'videoq-api',dead_letter_queue:`videoq-${kind}-dlq-prod`}]}));
 const workflows=[{id:'search-job',version_id:'11111111-2222-4333-8444-555555555555',status:'paused'}];
 const settings={bindings:[{name:'SEARCH_INDEX_WORKFLOW',type:'workflow'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'}]},production={vars:{SEARCH_JOB_BACKEND:'sqs'}};
 const reads=[];
 const request=async(method,path)=>{assert.equal(method,'GET');reads.push(path);if(path.includes('/workflows/'))return{success:true,result:structuredClone(workflows)};if(path.includes('?'))return{success:true,result:structuredClone(queues)};return{success:true,result:structuredClone(queues.find(row=>path.endsWith('/'+row.queue_id)))};};
 return{queues,workflows,settings,production,reads,options:{production,settings,request,now:()=>now}};
}
test('bound consumers require stopped queues, an elapsed consumer window and paused or terminal Workflows',async()=>{
 const f=fixture();assert.deepEqual(await assertBackgroundMigrationFence(f.options),{required:true,queueAdmissionPaused:true,consumerDrainWindowElapsed:true,workflowsPaused:true});
 assert.ok(f.reads.some(path=>path.includes('/workflows/')));
});
test('pause, timestamp, identity and Workflow failures prevent the fence',async()=>{
 for(const mutate of [f=>{f.queues[0].settings.delivery_paused=false;},f=>{f.queues[1].modified_on='2026-11-22T14:45:00Z';},f=>{f.queues[1].modified_on='invalid';},f=>{f.queues[1].modified_on='2026-11-22T15:01:00Z';},f=>{f.queues[1].consumers[0].script_name='other';},f=>{f.settings.bindings[1].text='running';},...['running','waiting','queued','waitingForPause','rollingBack','unknown'].map(status=>f=>{f.workflows[0].status=status;})]){
  const f=fixture();mutate(f);await assert.rejects(assertBackgroundMigrationFence(f.options));
 }
});
test('SQS routing with bindings still requires the fence; a legacy unbound deployment does not',async()=>{
 const f=fixture();f.queues[0].settings.delivery_paused=false;await assert.rejects(assertBackgroundMigrationFence(f.options));
 f.settings.bindings=f.settings.bindings.filter(row=>row.name!=='SEARCH_INDEX_WORKFLOW');
 assert.deepEqual(await assertBackgroundMigrationFence(f.options),{required:false});assert.equal(f.production.vars.SEARCH_JOB_BACKEND,'sqs');
 f.production.queues={consumers:[{queue:'videoq-search-prod'}]};await assert.rejects(assertBackgroundMigrationFence(f.options));
});
test('read transport cannot mutate queues, read Workflow payloads or reach another account',async()=>{
 let calls=0;const request=createBackgroundMigrationReadTransport({token:'synthetic-token-0123456789',fetcher:async()=>{calls++;return Response.json({success:true,result:[]});}}),base='accounts/12daec56fdba43f677f2766ee26a5a39/';
 await request('GET',base+'workflows/videoq-search-index-prod/instances?per_page=100&direction=asc&cursor=next%2Bpage');assert.equal(calls,1);
 for(const [method,path] of [['PATCH',base+'queues/'+'1'.repeat(32)],['GET',base+'workflows/videoq-search-index-prod/instances/job'],['GET',base+'queues?name=other'],['GET','accounts/'+'a'.repeat(32)+'/queues?page=1&per_page=500']])await assert.rejects(request(method,path),/SCOPE/);
 assert.equal(calls,1);
});
test('read errors fail without leaking provider response data',async()=>{
 for(const fetcher of [async()=>new Response('private',{status:403}),async()=>Response.json({success:false,errors:['private']}),async()=>new Response('private')]){
  const request=createBackgroundMigrationReadTransport({token:'synthetic-token-0123456789',fetcher});
  await assert.rejects(request('GET','accounts/12daec56fdba43f677f2766ee26a5a39/queues?page=1&per_page=500'),error=>!error.message.includes('private'));
 }
});
