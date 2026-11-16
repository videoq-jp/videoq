const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceVectorAdapter}=require('./d1-resource-vectors.cjs');
function fixture(){
 const run='a'.repeat(32),calls=[],fence={owner:run};let safe=true,state={verified:false,reconciliationRequired:false};
 const options={run,source:'b'.repeat(40),directory:'/private/owned',token:'SYNTHETIC_TOKEN',plans:{load:async()=>fence},assertCopyVerified:async()=>{if(!safe)throw Error('RESOURCE_COPY_REQUIRED');},bridge:{call:async(action,input,token)=>{assert.equal(token,'SYNTHETIC_TOKEN');calls.push(action);return action==='prepare-vectors'?{manifestSha256:'c'.repeat(64),batches:2,vectors:500,deferredPending:0}:action==='inspect-vectors'?state:{verified:false};}}};
 return{adapter:createResourceVectorAdapter(options),calls,unsafe:()=>safe=false,state:value=>state=value,context:{assertOwnership:async()=>{}}};
}
test('vector adapter keeps large payloads private and distinguishes progress, unknown and exact proof',async()=>{
 const f=fixture(),p=await f.adapter.prepare();assert.equal(p.vectors,500);assert.ok(!JSON.stringify(p).includes('values'));
 assert.equal((await f.adapter.probe(p)).state,'not-applied');assert.deepEqual(await f.adapter.apply(p,f.context),{pending:true});f.state({verified:false,reconciliationRequired:true});assert.equal((await f.adapter.probe(p)).state,'unknown');f.state({verified:true,receiptSha256:'d'.repeat(64)});assert.equal((await f.adapter.probe(p)).state,'applied');
});
test('missing database-copy proof or substituted vector artifact context refuses provider calls',async()=>{
 const f=fixture(),p=await f.adapter.prepare(),before=f.calls.length;await assert.rejects(f.adapter.apply({...p,directory:'/other'},f.context),/PLAN_REQUIRED/);f.unsafe();await assert.rejects(f.adapter.probe(p),/COPY_REQUIRED/);assert.equal(f.calls.length,before);
});
