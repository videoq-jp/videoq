const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createResourceJournal,RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const RUN='a'.repeat(32),SOURCE='b'.repeat(40),SHA='c'.repeat(64),RECEIPT='d'.repeat(64);
const ARN='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+RUN;
const SPEC={States:{wait:{Type:'Wait',Seconds:10}}};
function fixture({enabled=true,lost=false,executorToken}={}){
 const rows=new Map([['maintenance',{kind:{S:'d1-resource-hold'},execution_arn:{S:ARN}}],['run#'+RUN,{kind:{S:'d1-resource-hold'},execution_arn:{S:ARN},source_sha:{S:SOURCE},resource_phase:{S:'holding'},resource_revision:{N:'0'},release_requested:{BOOL:false}}]]);let writes=0,status='RUNNING',spec=SPEC;
 const aws=async(service,command,v)=>{
  if(command==='GetItem')return{Item:structuredClone(rows.get(v.Key.pk.S))};
  if(command==='DescribeExecution')return{status};
  if(command==='DescribeStateMachineForExecution')return{definition:JSON.stringify(spec)};
  if(command==='TransactWriteItems'){
   const update=v.TransactItems[0].Update,vals=update.ExpressionAttributeValues,row=rows.get(update.Key.pk.S),owner=rows.get('maintenance');
   if(!owner||owner.execution_arn.S!==ARN||row.resource_revision.N!==vals[':previous'].N)throw Error('CAS_CONFLICT');
   if(update.UpdateExpression.includes('resource_abort_requested=:true')){row.resource_abort_requested={BOOL:true};}else if(vals[':steps']){row.resource_steps=vals[':steps'];row.resource_steps_sha256=vals[':sha'];}else{if(row.resource_executor_sha256)throw Error('CAS_CONFLICT');row.resource_executor_sha256=vals[':executor'];}
   row.resource_revision=vals[':next'];writes++;
   if(lost){lost=false;throw Error('LOST_RESPONSE');}return{};
  }
  throw Error('Unexpected operation');
 };
 return{rows,journal:createResourceJournal({aws,run:RUN,source:SOURCE,expectedDefinitionHash:resourceDigest(SPEC),executorToken,enabled}),writes:()=>writes,loseNext:()=>{lost=true;},setStatus:s=>{status=s;},setSpec:s=>{spec=s;}};
}
const plan=step=>({step,planSha256:SHA}),proof=step=>({...plan(step),receiptSha256:RECEIPT});
test('journal is disabled by default before any AWS call',async()=>{
 const j=createResourceJournal({aws:()=>assert.fail('AWS called'),run:RUN,source:SOURCE,expectedDefinitionHash:SHA});await assert.rejects(j.inspect(),/DISABLED/);
});
test('intent precedes every step and completed operations cannot be mutated again',async()=>{
 const f=fixture(),j=f.journal;
 for(const step of RESOURCE_STEPS){
  await assert.rejects(j.verify(proof(step)),/NOT_PENDING/);
  const r=await j.begin(plan(step));assert.equal(r.state,'intent');assert.deepEqual(await j.begin(plan(step)),r);
  assert.equal((await j.assertPending(plan(step))).operationId,r.operationId);
  assert.equal((await j.verify(proof(step))).state,'verified');assert.equal((await j.verify(proof(step))).state,'verified');
  await assert.rejects(j.assertPending(plan(step)),/NOT_PENDING/);
 }
 assert.equal(f.writes(),RESOURCE_STEPS.length*2);assert.equal((await j.inspect()).nextStep,null);
});
test('out-of-order steps, changed plans, changed receipts and data-plane arguments are rejected',async()=>{
 const j=fixture().journal,first=RESOURCE_STEPS[0];
 await assert.rejects(j.begin(plan(RESOURCE_STEPS[1])),/ORDER_REQUIRED/);
 await assert.rejects(j.begin({...plan(first),sql:'secret payload'}),/ARGUMENTS/);
 await j.begin(plan(first));await assert.rejects(j.begin({...plan(first),planSha256:'e'.repeat(64)}),/PLAN_CHANGED/);
 await j.verify(proof(first));await assert.rejects(j.verify({...proof(first),receiptSha256:'e'.repeat(64)}),/PROOF_CHANGED/);
});
test('a lost transaction response reconciles durable intent without duplicating it',async()=>{
 const f=fixture({lost:true}),step=RESOURCE_STEPS[0];await f.journal.begin(plan(step));assert.equal(f.writes(),1);await f.journal.begin(plan(step));assert.equal(f.writes(),1);
});
test('corrupt journal, lost owner, terminal execution and changed definition fail closed',async()=>{
 for(const mutation of [f=>f.rows.delete('maintenance'),f=>f.setStatus('TIMED_OUT'),f=>f.setSpec({changed:true}),f=>{f.rows.get('run#'+RUN).resource_steps_sha256={S:SHA};},f=>{const r=f.rows.get('run#'+RUN);r.resource_steps={S:'private malformed json'};r.resource_steps_sha256={S:SHA};}]){
  const f=fixture();mutation(f);await assert.rejects(f.journal.begin(plan(RESOURCE_STEPS[0])),e=>/^[A-Z_]+$/.test(e.message));assert.equal(f.writes(),0);
 }
});
test('promotion intent permanently prevents a simple source rollback even before completion',async()=>{
 const j=fixture().journal;
 for(const step of RESOURCE_STEPS){
  if(step==='promote-bindings'){await j.begin(plan(step));await assert.rejects(j.assertPrePromotionAbort(),/FORWARD_RECOVERY/);break;}
  await j.begin(plan(step));await j.verify(proof(step));
 }
});

test('execution-definition hashes match the existing deployed bundle convention',()=>{
 const {definition}=require('../../infra/db-maintenance/state-machine.cjs');
 const {definitionHash}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
 const spec=definition({table:'videoq-db-maintenance-prod',projects:{migration:'migration',smoke:'smoke',deploy:'deploy'},neonRetired:true});
 assert.equal(resourceDigest(spec),definitionHash(spec));
});
test('executor is explicitly claimed before steps and survives lost claim response',async()=>{
 const f=fixture({executorToken:'1'.repeat(64),lost:true}),j=f.journal;
 await assert.rejects(j.inspect(),/EXECUTOR_OWNERSHIP/);await assert.rejects(j.assertExecutor(),/EXECUTOR_OWNERSHIP/);
 assert.deepEqual(await j.claimExecutor(),{claimed:true});assert.deepEqual(await j.assertExecutor(),{owned:true});await j.claimExecutor();assert.equal(f.writes(),1);
 await j.begin(plan(RESOURCE_STEPS[0]));assert.equal((await j.inspect()).steps.length,1);
 f.rows.get('run#'+RUN).resource_executor_sha256={S:'f'.repeat(64)};await assert.rejects(j.assertExecutor(),/EXECUTOR_OWNERSHIP/);await assert.rejects(j.verify(proof(RESOURCE_STEPS[0])),/EXECUTOR_OWNERSHIP/);
});
test('executor callbacks cannot use an unbound journal and late claims refuse prior work',async()=>{
 const f=fixture();await assert.rejects(f.journal.claimExecutor(),/TOKEN_REQUIRED/);await assert.rejects(f.journal.assertExecutor(),/TOKEN_REQUIRED/);
 const g=fixture({executorToken:'1'.repeat(64)});g.rows.get('run#'+RUN).resource_steps={S:'[]'};g.rows.get('run#'+RUN).resource_steps_sha256={S:resourceDigest([])};await assert.rejects(g.journal.claimExecutor(),/BEFORE_STEPS/);
});

test('durable pre-promotion abort blocks normal executor and step progress without releasing ownership',async()=>{
 const f=fixture({executorToken:'1'.repeat(64)}),j=f.journal;await j.claimExecutor();await j.begin(plan(RESOURCE_STEPS[0]));await j.requestAbort();assert.deepEqual(await j.requestAbort(),{abortRequested:true});
 assert.equal((await j.assertAbortExecutor()).sourceFenceMayExist,false);assert.ok(f.rows.get('maintenance'));await assert.rejects(j.assertExecutor(),/ABORT_IN_PROGRESS/);await assert.rejects(j.verify(proof(RESOURCE_STEPS[0])),/ABORT_IN_PROGRESS/);await assert.rejects(j.begin(plan(RESOURCE_STEPS[1])),/ABORT_IN_PROGRESS/);
});
test('abort requires claimed executor and retains sticky promotion restriction',async()=>{
 const f=fixture();await assert.rejects(f.journal.requestAbort(),/TOKEN_REQUIRED/);
 const g=fixture({executorToken:'1'.repeat(64)});await g.journal.claimExecutor();await assert.rejects(g.journal.assertAbortExecutor(),/REQUEST_REQUIRED/);
 for(const step of RESOURCE_STEPS){await g.journal.begin(plan(step));if(step==='promote-bindings')break;await g.journal.verify(proof(step));}
 await assert.rejects(g.journal.requestAbort(),/FORWARD_RECOVERY/);assert.equal(g.rows.get('run#'+RUN).resource_abort_requested,undefined);
});

test('lost abort request response reads back durable mode and retains original owner',async()=>{
 const f=fixture({executorToken:'1'.repeat(64)});await f.journal.claimExecutor();f.loseNext();await f.journal.requestAbort();assert.equal((await f.journal.assertAbortExecutor()).run,RUN);assert.equal(f.writes(),2);
});
