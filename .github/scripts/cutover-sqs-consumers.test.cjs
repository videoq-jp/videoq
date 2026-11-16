const {test}=require('node:test'),assert=require('node:assert/strict');
const {createConsumerControl}=require('./cutover-sqs-consumers.cjs');
function fixture(){
 const nonce='a'.repeat(16),names=['media','search','account'].map(g=>'videoq-cutover-'+nonce+'-'+g),updates=[];
 const rows=names.map((n,i)=>({UUID:'11111111-2222-4333-8444-55555555555'+i,FunctionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+n,EventSourceArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+n,State:i===2?'Disabled':'Enabled'}));
 let allowed=true;
 const aws=async(cmd,input)=>{if(cmd==='ListEventSourceMappings')return{EventSourceMappings:rows.filter(r=>r.FunctionArn.endsWith(':'+input.FunctionName))};assert.equal(cmd,'UpdateEventSourceMapping');updates.push(input);rows.find(r=>r.UUID===input.UUID).State=input.Enabled?'Enabled':'Disabled';return{};};
 const control=createConsumerControl(aws,{assertOwnership:async()=>{if(!allowed)throw Error('lost ownership');}});
 return{scope:{purpose:'isolated-rehearsal',nonce},control,aws,rows,updates,revoke:()=>allowed=false};
}
test('pause and resume preserve an originally disabled consumer and are idempotent',async()=>{
 const f=fixture(),plan=await f.control.prepare(f.scope);assert.equal(f.updates.length,0);
 assert.equal((await f.control.pause(plan)).admissionPaused,true);await f.control.pause(plan);assert.equal(f.updates.length,2);
 assert.equal((await f.control.resume(plan)).originalAdmissionRestored,true);await f.control.resume(plan);assert.equal(f.updates.length,4);assert.equal(f.rows[2].State,'Disabled');
});
test('no production mutation is possible without an ownership verifier',async()=>{
 const f=fixture(),plan=await f.control.prepare(f.scope),unowned=createConsumerControl(f.aws);await assert.rejects(unowned.pause(plan),/OWNERSHIP/);assert.equal(f.updates.length,0);
 f.revoke();await assert.rejects(f.control.pause(plan));assert.equal(f.updates.length,0);
});
test('replacement, cross-account scope and state drift fail before mutation',async()=>{
 for(const mutate of [f=>f.rows[0].UUID='11111111-2222-4333-8444-666666666666',f=>f.rows[0].EventSourceArn=f.rows[0].EventSourceArn.replace('257240362763','111111111111'),f=>f.rows[2].State='Enabled',f=>f.rows[0].State='Updating']){
  const f=fixture(),plan=await f.control.prepare(f.scope);mutate(f);await assert.rejects(f.control.pause(plan));assert.equal(f.updates.length,0);
 }
 const f=fixture();await assert.rejects(f.control.prepare({purpose:'production',nonce:'extra'}),/SCOPE/);
});
test('transitional disabling/enabling is reported without toggling the operation',async()=>{
 const f=fixture(),plan=await f.control.prepare(f.scope);f.rows[0].State='Disabling';f.rows[1].State='Disabled';assert.equal((await f.control.pause(plan)).admissionPaused,false);assert.equal(f.updates.length,0);
 await assert.rejects(f.control.resume(plan),/STATE_DRIFT/);f.rows[0].State='Enabling';assert.equal((await f.control.resume(plan)).originalAdmissionRestored,false);assert.equal(f.updates.length,1);
});
test('lost successful update responses can be retried without restoring partial state',async()=>{
 const f=fixture();let lose=true;const control=createConsumerControl(async(cmd,input)=>{const r=await f.aws(cmd,input);if(cmd==='UpdateEventSourceMapping'&&lose){lose=false;throw Error('lost response');}return r;},{assertOwnership:async()=>{}}),plan=await control.prepare(f.scope);
 await assert.rejects(control.pause(plan));assert.equal(f.rows[0].State,'Disabled');assert.equal(f.rows[1].State,'Enabled');assert.equal((await control.pause(plan)).admissionPaused,true);
});
test('ownership loss between mutations leaves the partial stop intact',async()=>{
 const f=fixture();let checks=0;const control=createConsumerControl(f.aws,{assertOwnership:async()=>{if(++checks===3)throw Error('lost ownership');}}),plan=await control.prepare(f.scope);
 await assert.rejects(control.pause(plan));assert.equal(f.rows[0].State,'Disabled');assert.equal(f.rows[1].State,'Enabled');assert.equal(f.updates.length,1);
});
test('an additional or paginated mapping cannot be hidden by preparation',async()=>{
 for(const response of [{EventSourceMappings:[],NextMarker:'more'},{EventSourceMappings:[{},{}]}]){
  const f=fixture(),control=createConsumerControl(async()=>response);await assert.rejects(control.prepare(f.scope),/INVENTORY/);
 }
});
