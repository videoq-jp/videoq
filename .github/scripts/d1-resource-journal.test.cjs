const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createResourceJournal,RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const RUN='a'.repeat(32),SOURCE='b'.repeat(40),SHA='c'.repeat(64),RECEIPT='d'.repeat(64);
const ARN='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+RUN;
const SPEC={States:{wait:{Type:'Wait',Seconds:10}}};
function fixture({enabled=true,lost=false}={}){
 const rows=new Map([['maintenance',{kind:{S:'d1-resource-hold'},execution_arn:{S:ARN}}],['run#'+RUN,{kind:{S:'d1-resource-hold'},execution_arn:{S:ARN},source_sha:{S:SOURCE},resource_phase:{S:'holding'},resource_revision:{N:'0'},release_requested:{BOOL:false}}]]);let writes=0,status='RUNNING',spec=SPEC;
 const aws=async(service,command,v)=>{
  if(command==='GetItem')return{Item:structuredClone(rows.get(v.Key.pk.S))};
  if(command==='DescribeExecution')return{status};
  if(command==='DescribeStateMachineForExecution')return{definition:JSON.stringify(spec)};
  if(command==='TransactWriteItems'){
   const update=v.TransactItems[0].Update,vals=update.ExpressionAttributeValues,row=rows.get(update.Key.pk.S),owner=rows.get('maintenance');
   if(!owner||owner.execution_arn.S!==ARN||row.resource_revision.N!==vals[':previous'].N)throw Error('CAS_CONFLICT');
   row.resource_steps=vals[':steps'];row.resource_steps_sha256=vals[':sha'];row.resource_revision=vals[':next'];writes++;
   if(lost){lost=false;throw Error('LOST_RESPONSE');}return{};
  }
  throw Error('Unexpected operation');
 };
 return{rows,journal:createResourceJournal({aws,run:RUN,source:SOURCE,expectedDefinitionHash:resourceDigest(SPEC),enabled}),writes:()=>writes,setStatus:s=>{status=s;},setSpec:s=>{spec=s;}};
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
