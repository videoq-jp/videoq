const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBackgroundMaintenanceTransport}=require('./background-maintenance-transport.cjs');
const base='accounts/12daec56fdba43f677f2766ee26a5a39/',id='1'.repeat(32),token='synthetic-control-token-0123456789';
test('control transport accepts only scoped pause/resume and delivery flags',async()=>{
 const writes=[];const request=createBackgroundMaintenanceTransport({token,fetcher:async(url,options)=>{
  if(options.method==='GET')return Response.json({success:true,result:{queue_id:id,queue_name:'videoq-account-prod'}});
  writes.push(JSON.parse(options.body));return Response.json({success:true});
 }});
 await request('PATCH',base+'queues/'+id,{settings:{delivery_paused:true}});
 await request('PATCH',base+'workflows/videoq-search-index-prod/instances/job-one/status',{status:'resume'});
 for(const [path,body] of [[base+'queues/'+id,{settings:{message_retention_period:0}}],[base+'workflows/videoq-search-index-prod/instances/job-one/status',{status:'terminate'}],[base+'workflows/other/instances/job/status',{status:'pause'}]])await assert.rejects(request('PATCH',path,body),/SCOPE/);
 assert.equal(writes.length,2);
});
test('queue metadata must identify the intended queue before a write',async()=>{
 let writes=0;const request=createBackgroundMaintenanceTransport({token,fetcher:async(_url,options)=>{if(options.method!=='GET')writes++;return Response.json({success:true,result:{queue_id:id,queue_name:'unrelated'}});}});
 await assert.rejects(request('PATCH',base+'queues/'+id,{settings:{delivery_paused:true}}),/QUEUE_SCOPE/);assert.equal(writes,0);
});
