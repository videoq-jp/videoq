const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBroker}=require('../../infra/db-maintenance/runtime/broker.cjs');
const {input,D1_HOLD_KIND}=require('../../infra/db-maintenance/runtime/policy.cjs');
const {definition}=require('../../infra/db-maintenance/state-machine.cjs');
const MACHINE='arn:aws:states:ap-northeast-1:257240362763:stateMachine:videoq-db-maintenance-prod',SHA='a'.repeat(40),TOKEN='b'.repeat(32);
function fixture({main=SHA,active=false}={}){
 const rows=new Map(),states=new Map(),calls=[];
 const aws=async(service,command,value)=>{
  calls.push({service,command,value});
  if(command==='GetItem')return{Item:rows.get(value.Key.pk.S)};
  if(command==='ListBuildsForProject')return{ids:active?['active']:[]};
  if(command==='BatchGetBuilds')return{builds:[{buildComplete:false}]};
  if(command==='TransactWriteItems'){
   for(const op of value.TransactItems){assert.ok(op.Put);assert.ok(!rows.has(op.Put.Item.pk.S));rows.set(op.Put.Item.pk.S,op.Put.Item);}return{};
  }
  if(command==='StartExecution'){states.set(MACHINE.replace(':stateMachine:',':execution:')+':'+value.name,'RUNNING');return{};}
  if(command==='DescribeExecution'){const state=states.get(value.executionArn);if(!state)throw Object.assign(Error('missing'),{name:'ExecutionDoesNotExist'});return{status:state};}
  throw Error('Unexpected fixture operation '+command);
 };
 return{rows,states,calls,broker:createBroker(aws,{table:'metadata',machine:MACHINE,projects:['migration','smoke','deploy'],allowedKinds:['migration',D1_HOLD_KIND]},async()=>main)};
}
const event={action:'start',kind:D1_HOLD_KIND,source_sha:SHA,client_token:TOKEN};
test('D1 resource hold is opt-in, main-pinned and accepts no execution or target overrides',async()=>{
 assert.throws(()=>input(event,['migration']),/NOT_ALLOWED/);
 for(const extra of [{target:'other'},{writers_stopped:true},{force:true},{verify_ai_answers:true}])assert.throws(()=>input({...event,...extra},[D1_HOLD_KIND]));
 const f=fixture({main:'c'.repeat(40)});await assert.rejects(f.broker(event),/CURRENT_MAIN/);assert.ok(!f.calls.some(c=>c.command==='StartExecution'));
 const busy=fixture({active:true});await assert.rejects(busy.broker(event),/STILL_RUNNING/);
});
test('D1 hold persists non-expiring ownership and source before starting, without creating a build',async()=>{
 const f=fixture(),r=await f.broker(event),row=f.rows.get('run#'+r.run_id);
 assert.equal(row.kind.S,D1_HOLD_KIND);assert.equal(row.source_sha.S,SHA);assert.equal(row.resource_phase.S,'holding');assert.equal(row.release_requested.BOOL,false);assert.equal(row.expires_at,undefined);
 assert.ok(f.calls.findIndex(c=>c.command==='TransactWriteItems')<f.calls.findIndex(c=>c.command==='StartExecution'));
 assert.ok(!f.calls.some(c=>c.command==='StartBuild'));
 const status=await f.broker({action:'status',run_id:r.run_id});assert.equal(status.resource_hold,true);
 assert.deepEqual(await f.broker(event),r);
 await assert.rejects(f.broker({...event,source_sha:'d'.repeat(40)}),/SOURCE_CHANGED/);
});
test('all terminal D1 holds retain the global lock until explicit verified recovery',async()=>{
 for(const status of ['FAILED','TIMED_OUT','ABORTED','SUCCEEDED']){
  const f=fixture(),r=await f.broker(event),owner=f.rows.get('maintenance');f.states.set(owner.execution_arn.S,status);
  await assert.rejects(f.broker({...event,client_token:'c'.repeat(32)}),/D1_RESOURCE_HOLD_RECOVERY_REQUIRED/);
  assert.equal(f.rows.get('maintenance'),owner);
  if(status!=='SUCCEEDED')assert.equal((await f.broker({action:'status',run_id:r.run_id})).recovery_required,true);
 }
});
test('running D1 hold refuses lost ownership on status and repeated start',async()=>{
 const f=fixture(),r=await f.broker(event);f.rows.delete('maintenance');
 await assert.rejects(f.broker({action:'status',run_id:r.run_id}),/OWNERSHIP_LOST/);
 await assert.rejects(f.broker(event),/OWNERSHIP_LOST/);
});
test('D1-only graph waits without builds and releases only with owned source and restored-admission receipts',()=>{
 const states=definition({table:'metadata',projects:{migration:'migration',smoke:'smoke',deploy:'deploy'},neonRetired:true}).States;
 assert.ok(!JSON.stringify(definition({table:'metadata',projects:{},neonRetired:false})).includes(D1_HOLD_KIND));
 const entry=states.Operation.Choices.find(c=>c.StringEquals===D1_HOLD_KIND);assert.equal(entry.Next,'ReadD1ResourceHold');
 assert.equal(states.WaitD1ResourceHold.Next,'ReadD1ResourceHold');
 const tx=states.ReleaseD1ResourceHold.Parameters.TransactItems;assert.equal(tx.length,2);
 for(const key of ['source_sha','resource_completion_receipt','api_admission_restored','consumer_admission_restored','deployment_admission_restored'])assert.ok(tx[0].ConditionCheck.ConditionExpression.includes(key));
 assert.ok(tx[1].Delete.ConditionExpression.includes('#kind = :kind'));
 assert.equal(tx[1].Delete.ExpressionAttributeValues[':kind'].S,D1_HOLD_KIND);
 assert.equal(states.InvalidD1ResourceHold.Type,'Fail');
});

test('D1 hold status refuses contradictory release markers',async()=>{
 const f=fixture(),r=await f.broker(event),row=f.rows.get('run#'+r.run_id);row.release_requested={BOOL:true};
 await assert.rejects(f.broker({action:'status',run_id:r.run_id}),/OWNERSHIP_LOST/);
});
