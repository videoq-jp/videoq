const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBackgroundMaintenance}=require('./background-maintenance.cjs');
function fixture(){
 const queues=['account','search'].map((kind,i)=>({queue_id:String(i+1).repeat(32),queue_name:`videoq-${kind}-prod`,settings:{message_retention_period:345600,delivery_paused:i===1},consumers:[{type:'worker',script_name:'videoq-api',dead_letter_queue:`videoq-${kind}-dlq-prod`}]}));
 const workflows=['running','paused'].map((status,i)=>({id:'job-'+i,status,version_id:'11111111-2222-4333-8444-555555555555'}));
 const stored=new Map(),writes=[];let time=1000,fail,owner=true,apiPaused=true,safe=true;
 const plans={load:async key=>structuredClone(stored.get(key)??null),save:async(key,value)=>{assert.equal(stored.has(key),false);stored.set(key,structuredClone(value));}};
 const request=async(method,path,body)=>{
  if(path.includes('/workflows/')){
   if(method==='GET')return{success:true,result:structuredClone(workflows)};
   const row=workflows.find(row=>path.endsWith('/'+row.id+'/status'));assert.ok(row);writes.push(body.status);row.status=body.status==='pause'?'waitingForPause':'running';
  }else if(method==='GET')return{success:true,result:structuredClone(path.includes('?')?queues:queues.find(row=>path.endsWith('/'+row.queue_id)))};
  else{const row=queues.find(row=>path.endsWith('/'+row.queue_id));assert.ok(row);writes.push('queue-'+body.settings.delivery_paused);Object.assign(row.settings,body.settings);}
  if(fail)throw Error('provider response lost');return{success:true,result:{}};
 };
 const options={request,plans,now:()=>time,assertOwnership:async()=>{if(!owner)throw Error('owner');},assertApiPaused:async()=>{if(!apiPaused)throw Error('api');},assertRestoreSafe:async()=>{if(!safe)throw Error('database');}};
 return{queues,workflows,stored,writes,options,create:()=>createBackgroundMaintenance(options),advance:ms=>{time+=ms;},fail:v=>{fail=v;},owner:v=>{owner=v;},api:v=>{apiPaused=v;},safe:v=>{safe=v;}};
}
test('durable records survive process replacement through drain, Workflow pause and restoration',async()=>{
 const f=fixture();assert.equal((await f.create().pause()).status,'draining-consumers');
 assert.deepEqual([...f.stored.keys()],['background-queues','background-drain']);assert.equal(f.writes.length,1);
 f.advance(15*60*1000);assert.equal((await f.create().pause()).status,'draining-consumers');assert.equal(f.writes.length,1);
 f.advance(60*1000);assert.equal((await f.create().pause()).status,'pausing-workflows');assert.equal(f.writes.length,2);
 f.workflows[0].status='paused';assert.equal((await f.create().pause()).status,'paused');
 assert.deepEqual(await f.create().restore(),{status:'restored',apiTrafficRestored:false});
 assert.deepEqual(f.queues.map(row=>row.settings.delivery_paused),[false,true]);assert.deepEqual(f.workflows.map(row=>row.status),['running','paused']);
 const count=f.writes.length;await f.create().restore();assert.equal(f.writes.length,count);
 await assert.rejects(f.create().pause(),/RESTORE_ALREADY_STARTED/);
});
test('lost provider acknowledgements reuse persisted originals rather than capturing changed states',async()=>{
 const f=fixture();f.fail(true);await f.create().pause();const original=structuredClone(f.stored.get('background-queues'));
 f.advance(16*60*1000);await f.create().pause();f.workflows[0].status='paused';await f.create().pause();await f.create().restore();
 assert.deepEqual(f.stored.get('background-queues'),original);assert.deepEqual(f.queues.map(row=>row.settings.delivery_paused),[false,true]);
});
test('unsafe restoration, lost lease and reopened API cannot mutate resources',async()=>{
 const f=fixture();await f.create().pause();const count=f.writes.length;
 f.safe(false);await assert.rejects(f.create().restore(),/database/);assert.equal(f.writes.length,count);assert.equal(f.stored.has('background-restore'),false);
 f.safe(true);f.owner(false);await assert.rejects(f.create().restore(),/owner/);f.owner(true);f.api(false);await assert.rejects(f.create().pause(),/api/);assert.equal(f.writes.length,count);
});
test('missing original records and corrupt drain records fail without inventing state',async()=>{
 const f=fixture();await assert.rejects(f.create().restore(),/ORIGINAL_PLAN/);await f.create().pause();f.stored.get('background-drain').queuePlanSha256='a'.repeat(64);
 const count=f.writes.length;await assert.rejects(f.create().pause(),/DRAIN_RECORD/);assert.equal(f.writes.length,count);
});
test('failed durable persistence prevents all control-plane writes',async()=>{
 const f=fixture();f.options.plans={load:async()=>null,save:async()=>{}};await assert.rejects(f.create().pause(),/NOT_DURABLE/);assert.equal(f.writes.length,0);
});
test('pause cannot complete while a previously unobserved Workflow appears',async()=>{
 const f=fixture();await f.create().pause();f.advance(16*60*1000);await f.create().pause();f.workflows.push({...f.workflows[0],id:'new-job'});
 await assert.rejects(f.create().pause(),/NEW_INSTANCE/);
});
