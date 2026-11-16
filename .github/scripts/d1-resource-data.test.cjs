const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceDataAdapters}=require('./d1-resource-data.cjs');
function fixture(){
 const run='a'.repeat(32),stored=new Map(),calls=[];let installed=[],verified=false,reconciliation=false,safe=true;
 const plan={owner:run},options={run,source:'b'.repeat(40),directory:'/private/owned-artifacts',token:'SYNTHETIC_TOKEN',plans:{load:async step=>stored.get(step)??null},assertTargetSafe:async()=>{if(!safe)throw Error('RESOURCE_TARGET_UNSAFE');},bridge:{call:async(action,input,token)=>{
  assert.equal(token,'SYNTHETIC_TOKEN');calls.push(action);
  if(action==='prepare-fence')return plan;
  if(action==='prepare-copy')return{tables:[{table:'users',rows:1}]};
  if(action.startsWith('inspect-')&&action.endsWith('-fence'))return{installed:[...installed],total:3,schemaSha256:'c'.repeat(64)};
  if(action==='install-source-fence'){installed=['a','b','c'];return{};}
  if(action==='remove-target-fence'){installed=[];return{};}
  if(action==='inspect-copy')return{databaseVerified:verified,reconciliationRequired:reconciliation,...(verified?{receiptSha256:'d'.repeat(64)}:{})};
  if(action==='advance-copy')return{phase:'export-handle'};
  assert.fail(action);
 }}};
 return{adapters:createResourceDataAdapters(options),stored,calls,plan,context:{assertOwnership:async()=>{}},verify:()=>verified=true,reconcile:()=>reconciliation=true,unsafe:()=>safe=false};
}
test('fence adapters bind original plan and require safety before target removal',async()=>{
 const f=fixture(),a=f.adapters['fence-source'],p=await a.prepare();f.stored.set('fence-source',p);assert.equal((await a.probe(p)).state,'not-applied');await a.apply(p,f.context);assert.equal((await a.probe(p)).state,'applied');const target=f.adapters['unfence-target'];await target.apply(await target.prepare(),f.context);assert.equal((await target.probe(p)).state,'applied');f.unsafe();await assert.rejects(target.probe(p),/UNSAFE/);
});
test('copy adapter exposes pending stages and only verified database receipts complete it',async()=>{
 const f=fixture();f.stored.set('fence-source',f.plan);const a=f.adapters['copy-database'],p=await a.prepare();assert.equal((await a.probe(p)).state,'not-applied');assert.deepEqual(await a.apply(p,f.context),{pending:true});assert.equal((await a.probe(p)).state,'not-applied');f.reconcile();assert.equal((await a.probe(p)).state,'unknown');f.verify();assert.deepEqual(await a.probe(p),{state:'applied',receiptSha256:'d'.repeat(64)});
});
test('substituted fence or copy context refuses any data-plane request',async()=>{
 const f=fixture();f.stored.set('fence-source',f.plan);const a=f.adapters['copy-database'],p=await a.prepare(),count=f.calls.length;await assert.rejects(a.apply({...p,directory:'/other'},f.context),/COPY_PLAN/);await assert.rejects(f.adapters['fence-source'].apply({owner:'other'},f.context),/FENCE/);assert.equal(f.calls.length,count);
});
