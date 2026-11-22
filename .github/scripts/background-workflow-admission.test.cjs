const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBackgroundWorkflowAdmission}=require('./background-workflow-admission.cjs');
function fixture(){
 const version_id='11111111-2222-4333-8444-555555555555';
 const rows=['running','paused','complete','waiting','queued'].map((status,i)=>({id:'job-'+i,status,version_id}));
 const writes=[];let failure,owner=true,closed=true,safe=true;
 const request=async(method,path,body)=>{
  if(method==='GET')return{success:true,result:structuredClone(rows)};
  writes.push({path,body});if(failure==='before')throw Error('lost');
  const row=rows.find(row=>path.endsWith('/'+row.id+'/status'));assert.ok(row);
  row.status=body.status==='pause'?'waitingForPause':'running';if(failure==='after')throw Error('lost');
  return{success:true,result:{status:row.status}};
 };
 const options={assertOwnership:async()=>{if(!owner)throw Error('owner');},assertAdmissionClosed:async()=>{if(!closed)throw Error('admission');},assertRestoreSafe:async()=>{if(!safe)throw Error('restore');},sleep:async()=>{}};
 const control=createBackgroundWorkflowAdmission(request,options);
 return{rows,writes,request,control,options,fail:v=>{failure=v;},owner:v=>{owner=v;},closed:v=>{closed=v;},safe:v=>{safe=v;}};
}
test('waitingForPause is pending; resume restores active instances and preserves original pauses',async()=>{
 const f=fixture(),plan=await f.control.prepare();assert.equal(plan.instances.length,4);
 const pending=await f.control.change(plan,true);assert.equal(pending.executionPaused,false);assert.equal(pending.waitingForPause,true);
 await f.control.change(plan,true);assert.equal(f.writes.length,3);
 await assert.rejects(f.control.change(plan,false),/NOT_FINISHED/);
 for(const row of f.rows)if(row.status==='waitingForPause')row.status='paused';
 assert.equal((await f.control.inspect(plan)).executionPaused,true);
 assert.equal((await f.control.change(plan,false)).originalExecutionRestored,true);
 assert.equal(f.rows[1].status,'paused');assert.equal(f.writes.length,6);
 assert.ok(f.writes.every(row=>['pause','resume'].includes(row.body.status)));
});
test('lost acknowledgements reconcile without repeating pause requests',async()=>{
 const f=fixture(),plan=await f.control.prepare();f.fail('after');
 await f.control.change(plan,true);assert.equal(f.writes.length,3);
 await f.control.change(plan,true);assert.equal(f.writes.length,3);
});
test('failed pause is retryable; terminal completion while pausing needs no resume',async()=>{
 const f=fixture(),plan=await f.control.prepare();f.fail('before');
 await assert.rejects(f.control.change(plan,true),/lost/);assert.equal(f.rows[0].status,'running');
 f.fail(null);f.rows[0].status='complete';await f.control.change(plan,true);
 for(const row of f.rows)if(row.status==='waitingForPause')row.status='paused';
 await f.control.change(plan,false);assert.equal(f.rows[0].status,'complete');
 assert.equal(f.writes.filter(row=>row.path.includes('/job-0/')).length,1);
});
test('new instances, identity changes and missing instances prevent writes',async()=>{
 for(const mutate of [f=>f.rows.push({...f.rows[0],id:'new-job'}),f=>{f.rows[0].version_id='22222222-2222-4333-8444-555555555555';},f=>{f.rows.shift();}]){
  const f=fixture(),plan=await f.control.prepare();mutate(f);await assert.rejects(f.control.change(plan,true));assert.equal(f.writes.length,0);
 }
});
test('ownership, closed admission and safe restore are required',async()=>{
 for(const key of ['owner','closed']){
  const f=fixture(),plan=await f.control.prepare();f[key](false);await assert.rejects(f.control.change(plan,true));assert.equal(f.writes.length,0);
 }
 const f=fixture(),plan=await f.control.prepare();f.safe(false);await assert.rejects(f.control.change(plan,false),/restore/);assert.equal(f.writes.length,0);
 await assert.rejects(createBackgroundWorkflowAdmission(f.request).prepare(),/FENCE/);
 f.rows[0].status='waitingForPause';await assert.rejects(f.control.prepare(),/UNOWNED/);
});
test('cursor pagination keeps later active instances and refuses repeated cursors',async()=>{
 const f=fixture();let calls=0;
 const request=async(method,path)=>{assert.equal(method,'GET');calls++;if(path.includes('cursor=second'))return{success:true,result:[f.rows[0]]};return{success:true,result:[f.rows[1]],result_info:{cursor:'second'}};};
 const control=createBackgroundWorkflowAdmission(request,{assertAdmissionClosed:async()=>{}});
 const plan=await control.prepare();assert.equal(plan.instances.length,2);assert.equal(calls,2);
 const broken=createBackgroundWorkflowAdmission(async()=>({success:true,result:[],result_info:{cursor:'same'}}),{assertAdmissionClosed:async()=>{}});
 await assert.rejects(broken.prepare(),/CURSOR/);
});

test('Workflow pause and resume wait for delayed metadata without duplicate control requests',async()=>{
 const f=fixture();f.rows.splice(2);let pending=null,sleeps=0;
 const request=async(method,path,body)=>{
  const result=await f.request(method,path,body);
  if(method==='PATCH')pending={id:'job-0',status:body.status==='pause'?'running':'paused',remaining:3};
  else if(pending?.remaining>0){pending.remaining--;result.result.find(row=>row.id===pending.id).status=pending.status;}
  return result;
 };
 const c=createBackgroundWorkflowAdmission(request,{...f.options,sleep:async ms=>{assert.equal(ms,1000);sleeps++;}}),plan=await c.prepare();
 assert.equal((await c.change(plan,true)).waitingForPause,true);f.rows[0].status='paused';
 assert.equal((await c.change(plan,false)).originalExecutionRestored,true);
 assert.equal(f.writes.length,2);assert.equal(sleeps,6);assert.equal(f.rows[1].status,'paused');
});
test('Workflow readback timeout and changed admission/identity keep the original plan and stop writes',async()=>{
 for(const scenario of ['timeout','admission','identity']){
  const f=fixture();f.rows.splice(2);let pending=false,sleeps=0;
  const request=async(method,path,body)=>{
   const result=await f.request(method,path,body);if(method==='PATCH')pending=true;
   else if(pending)result.result.find(row=>row.id==='job-0').status='running';
   return result;
  };
  const c=createBackgroundWorkflowAdmission(request,{...f.options,sleep:async()=>{sleeps++;if(scenario==='admission')f.closed(false);if(scenario==='identity')f.rows[0].version_id='22222222-2222-4333-8444-555555555555';}}),plan=await c.prepare();
  await assert.rejects(c.change(plan,true),scenario==='timeout'?/UPDATE_INCOMPLETE/:scenario==='admission'?/admission/:/IDENTITY_CHANGED/);
  assert.equal(f.writes.length,1);assert.equal(sleeps,scenario==='timeout'?59:1);
 }
});
test('Workflow resume rechecks restoration safety during delayed readback',async()=>{
 const f=fixture(),plan=await f.control.prepare();await f.control.change(plan,true);for(const row of f.rows)if(row.status==='waitingForPause')row.status='paused';let pending=false;
 const request=async(method,path,body)=>{
  const result=await f.request(method,path,body);if(method==='PATCH')pending=true;
  else if(pending)result.result.find(row=>row.id==='job-0').status='paused';
  return result;
 };
 const c=createBackgroundWorkflowAdmission(request,{...f.options,sleep:async()=>f.safe(false)});
 await assert.rejects(c.change(plan,false),/restore/);assert.equal(f.writes.length,4);
});
