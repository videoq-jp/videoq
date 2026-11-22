const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBackgroundQueueAdmission}=require('./background-queue-admission.cjs');
function fixture(){
 const rows=['account','search'].map((kind,i)=>({queue_id:String(i+1).repeat(32),queue_name:`videoq-${kind}-prod`,settings:{delivery_paused:i===1,message_retention_period:345600,delivery_delay:10},consumers:[{consumer_id:String(i+3).repeat(32),type:'worker',script_name:'videoq-api',dead_letter_queue:`videoq-${kind}-dlq-prod`,settings:{batch_size:1,max_retries:8}}]}));
 const writes=[];let fail,owner=true,safe=true;
 const request=async(method,path,body)=>{
  if(path.includes('?'))return structuredClone(rows);
  const row=rows.find(row=>path.endsWith('/'+row.queue_id));assert.ok(row);
  if(method==='PATCH'){writes.push({path,body});if(fail==='before')throw Error('lost');Object.assign(row.settings,body.settings);if(fail==='after')throw Error('lost');}
  return structuredClone(row);
 };
 const options={assertOwnership:async()=>{if(!owner)throw Error('ownership');},assertRestoreSafe:async()=>{if(!safe)throw Error('fence');},sleep:async()=>{}};
 const control=createBackgroundQueueAdmission(request,options);
 return{rows,writes,request,control,options,setFail:value=>{fail=value;},setOwner:value=>{owner=value;},setSafe:value=>{safe=value;}};
}
test('pause and restore preserve a queue that was already paused and all other settings',async()=>{
 const f=fixture(),plan=await f.control.prepare();
 assert.equal((await f.control.inspect(plan)).admissionPaused,false);
 const paused=await f.control.change(plan,true);assert.equal(paused.admissionPaused,true);assert.equal(paused.inFlightDrainProven,false);
 await f.control.change(plan,true);assert.equal(f.writes.length,1);
 assert.equal((await f.control.change(plan,false)).originalAdmissionRestored,true);
 assert.deepEqual(f.rows.map(row=>row.settings.delivery_paused),[false,true]);
 assert.deepEqual(f.writes.map(row=>row.body),[{settings:{delivery_paused:true}},{settings:{delivery_paused:false}}]);
 assert.ok(f.rows.every(row=>row.settings.delivery_delay===10&&row.settings.message_retention_period===345600));
});
test('identity, consumer and settings drift on either queue prevent any mutation',async()=>{
 for(const mutate of [f=>{f.rows[1].queue_name='unrelated';},f=>{f.rows[1].settings.message_retention_period=500000;},f=>{f.rows[1].consumers[0].script_name='unrelated';}]){
  const f=fixture(),plan=await f.control.prepare();mutate(f);
  await assert.rejects(f.control.change(plan,true));assert.equal(f.writes.length,0);
 }
});
test('lost acknowledgements are read back and do not produce duplicate writes',async()=>{
 const f=fixture(),plan=await f.control.prepare();f.setFail('after');
 assert.equal((await f.control.change(plan,true)).admissionPaused,true);assert.equal(f.writes.length,1);
 await f.control.change(plan,true);assert.equal(f.writes.length,1);
});
test('failed writes remain retryable using the original plan',async()=>{
 const f=fixture(),plan=await f.control.prepare();f.setFail('before');
 await assert.rejects(f.control.change(plan,true),/lost/);assert.equal(f.rows[0].settings.delivery_paused,false);
 f.setFail(null);assert.equal((await f.control.change(plan,true)).admissionPaused,true);
});
test('ownership, restore fence and exact plan scope are mandatory',async()=>{
 const f=fixture(),plan=await f.control.prepare();f.setOwner(false);
 await assert.rejects(f.control.change(plan,true),/ownership/);assert.equal(f.writes.length,0);
 f.setOwner(true);await f.control.change(plan,true);f.setSafe(false);
 await assert.rejects(f.control.change(plan,false),/fence/);assert.equal(f.writes.length,1);
 await assert.rejects(f.control.change({...plan,account:'a'.repeat(32)},true),/PLAN/);
 await assert.rejects(createBackgroundQueueAdmission(f.request).change(plan,true),/OWNERSHIP/);
});
test('missing and duplicate queues cannot become an admission plan',async()=>{
 for(const mutate of [f=>{f.rows.pop();},f=>{f.rows.push(structuredClone(f.rows[0]));}]){
  const f=fixture();mutate(f);await assert.rejects(f.control.prepare(),/SCOPE/);
 }
});

test('live Queue API script metadata supports pause/restore and rejects conflicting aliases',async()=>{
 const f=fixture();
 for(const row of f.rows){row.consumers[0].script=row.consumers[0].script_name;delete row.consumers[0].script_name;}
 const plan=await f.control.prepare();
 assert.equal((await f.control.change(plan,true)).admissionPaused,true);
 assert.equal((await f.control.change(plan,false)).originalAdmissionRestored,true);
 for(const script of ['unrelated',null,'']){
  const invalid=fixture();invalid.rows[0].consumers[0].script=script;
  await assert.rejects(invalid.control.prepare(),/CONSUMER_DRIFT/);
  assert.equal(invalid.writes.length,0);
 }
 const drift=fixture(),original=await drift.control.prepare();
 drift.rows[0].consumers[0].script='unrelated';
 await assert.rejects(drift.control.change(original,true),/CONSUMER_DRIFT/);
 assert.equal(drift.writes.length,0);
});

test('pause and resume tolerate delayed GET visibility with one PATCH per transition',async()=>{
 const f=fixture();let delayed=0,sleeps=0;
 const request=async(method,path,body)=>{
  const result=await f.request(method,path,body);
  if(method==='PATCH')delayed=3;
  else if(delayed>0&&path.endsWith('/'+f.rows[0].queue_id)){delayed--;result.settings.delivery_paused=!f.rows[0].settings.delivery_paused;}
  return result;
 };
 const c=createBackgroundQueueAdmission(request,{...f.options,sleep:async ms=>{assert.equal(ms,1000);sleeps++;}}),plan=await c.prepare();
 assert.equal((await c.change(plan,true)).admissionPaused,true);
 assert.equal((await c.change(plan,false)).originalAdmissionRestored,true);
 assert.equal(f.writes.length,2);assert.equal(sleeps,6);assert.equal(plan.queues[0].originalPaused,false);
});
test('lost acknowledgement followed by stale reads does not repeat a successful PATCH',async()=>{
 const f=fixture();let delayed=0;
 const request=async(method,path,body)=>{
  if(method==='PATCH'){delayed=2;return f.request(method,path,body);}
  const result=await f.request(method,path,body);
  if(delayed>0&&path.endsWith('/'+f.rows[0].queue_id)){delayed--;result.settings.delivery_paused=false;}
  return result;
 };
 const c=createBackgroundQueueAdmission(request,f.options),plan=await c.prepare();f.setFail('after');
 assert.equal((await c.change(plan,true)).admissionPaused,true);assert.equal(f.writes.length,1);
});
test('readback polling is bounded and ownership/configuration drift stops it without another write',async()=>{
 for(const scenario of ['timeout','owner','configuration']){
  const f=fixture();let pending=false,sleeps=0;
  const request=async(method,path,body)=>{
   const result=await f.request(method,path,body);if(method==='PATCH')pending=true;
   else if(pending&&path.endsWith('/'+f.rows[0].queue_id))result.settings.delivery_paused=false;
   return result;
  };
  const c=createBackgroundQueueAdmission(request,{...f.options,sleep:async()=>{sleeps++;if(scenario==='owner')f.setOwner(false);if(scenario==='configuration')f.rows[0].settings.delivery_delay=99;}}),plan=await c.prepare();
  await assert.rejects(c.change(plan,true),scenario==='timeout'?/UPDATE_INCOMPLETE/:scenario==='owner'?/ownership/:/CONFIGURATION_CHANGED/);
  assert.equal(f.writes.length,1);assert.equal(sleeps,scenario==='timeout'?59:1);
 }
});
test('queue restore rechecks its safety fence while waiting for resume visibility',async()=>{
 const f=fixture(),plan=await f.control.prepare();await f.control.change(plan,true);let pending=false;
 const request=async(method,path,body)=>{
  const result=await f.request(method,path,body);if(method==='PATCH')pending=true;
  else if(pending&&path.endsWith('/'+f.rows[0].queue_id))result.settings.delivery_paused=true;
  return result;
 };
 const c=createBackgroundQueueAdmission(request,{...f.options,sleep:async()=>f.setSafe(false)});
 await assert.rejects(c.change(plan,false),/fence/);assert.equal(f.writes.length,2);
});
