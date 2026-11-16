const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceBindingAdapter}=require('./d1-resource-bindings.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
function fixture(){
 const settings={bindings:[{name:'DB',type:'d1',id:'e57d0931-18cb-4f00-ae7f-b0068030fb04',database_id:'e57d0931-18cb-4f00-ae7f-b0068030fb04'},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:'videoq-scenes-migration-v3-1536'},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:'videoq-scenes-migration-v3-768'},{name:'SECRET',type:'secret_text'},{name:'OTHER',type:'plain_text',text:'preserve'}],compatibility_date:'2026-08-20'},plans=new Map(),writes=[];
 let version='11111111-1111-1111-1111-111111111111',safe=true,lost=false;
 const request=async(method,path,body)=>{
  assert.ok(path.startsWith('accounts/12daec56fdba43f677f2766ee26a5a39/workers/scripts/videoq-api/'));
  if(method==='GET'){if(path.endsWith('/deployments'))return{deployments:[{id:'22222222-2222-2222-2222-222222222222',versions:[{version_id:version,percentage:100}]}]};if(path.endsWith('/versions?per_page=1'))return{items:[{id:version}]};return structuredClone(settings);}
  assert.equal(method,'PATCH');writes.push(body);settings.bindings=body.bindings.map(b=>b.type==='inherit'?settings.bindings.find(x=>x.name===b.name):b.type==='d1'?{...b,database_id:b.id}:b);if(lost){lost=false;throw Error('lost');}
 };
 const options={request,plans:{load:async step=>plans.get(step)??null},assertTransferVerified:async()=>{if(!safe)throw Error('RESOURCE_TRANSFER_NOT_VERIFIED');}};
 return{settings,plans,writes,request,options,adapter:createResourceBindingAdapter(options),context:{assertOwnership:async()=>{}},unsafe:()=>safe=false,lose:()=>lost=true,changeVersion:()=>version='33333333-3333-3333-3333-333333333333'};
}
async function prepared(f){const c=createApiTrafficControl(f.request,{assertOwnership:async()=>{}}),p=await c.prepare({purpose:'production'});f.plans.set('pause-api',p);await c.change(p,true);f.writes.length=0;return f.adapter.prepare();}
test('promotion changes only fixed DB/vector bindings, keeps traffic paused and inherits secrets',async()=>{
 const f=fixture(),plan=await prepared(f);assert.deepEqual(await f.adapter.probe(plan),{state:'not-applied'});await f.adapter.apply(plan,f.context);assert.equal((await f.adapter.probe(plan)).state,'applied');assert.equal(f.settings.bindings.find(b=>b.name==='DB').id,'587bd210-6d9d-4f32-abb7-a490013e65d3');assert.equal(f.settings.bindings.find(b=>b.name==='MIGRATION_TRAFFIC_STATE').text,'paused');assert.equal(f.settings.bindings.find(b=>b.name==='OTHER').text,'preserve');assert.deepEqual(f.writes[0].bindings.find(b=>b.name==='SECRET'),{name:'SECRET',type:'inherit'});await f.adapter.apply(plan,f.context);assert.equal(f.writes.length,1);assert.ok(!JSON.stringify(plan).includes('preserve'));
});
test('lost accepted promotion response reconciles target instead of replaying or rolling back',async()=>{
 const f=fixture(),plan=await prepared(f);f.lose();await assert.rejects(f.adapter.apply(plan,f.context),/lost/);assert.equal((await f.adapter.probe(plan)).state,'applied');await f.adapter.apply(plan,f.context);assert.equal(f.writes.length,1);
});
test('transfer proof and ownership are required before promotion',async()=>{
 const f=fixture(),plan=await prepared(f);await assert.rejects(f.adapter.apply(plan,{assertOwnership:async()=>{throw Error('revoked');}}),/revoked/);f.unsafe();await assert.rejects(f.adapter.apply(plan,f.context),/NOT_VERIFIED/);await assert.rejects(f.adapter.probe(plan),/NOT_VERIFIED/);assert.equal(f.writes.length,0);
});
test('unrelated settings drift, unpause and code drift cannot be promoted',async()=>{
 for(const mutate of [f=>f.settings.bindings.find(b=>b.name==='OTHER').text='drift',f=>f.settings.bindings.find(b=>b.name==='MIGRATION_TRAFFIC_STATE').text='running',f=>f.settings.compatibility_date='2026-11-17',f=>f.changeVersion()]){const f=fixture(),p=await prepared(f);mutate(f);await assert.rejects(f.adapter.apply(p,f.context));assert.equal(f.writes.length,0);}
});
test('partial promotion is unknown and cannot authorize a blind retry',async()=>{
 const f=fixture(),p=await prepared(f);f.settings.bindings.find(b=>b.name==='DB').id='587bd210-6d9d-4f32-abb7-a490013e65d3';assert.deepEqual(await f.adapter.probe(p),{state:'unknown'});await assert.rejects(f.adapter.apply(p,f.context),/RECONCILIATION/);assert.equal(f.writes.length,0);
});
test('missing original plan and a different source database refuse preparation',async()=>{
 const f=fixture();await assert.rejects(f.adapter.prepare());await prepared(f);f.settings.bindings.find(b=>b.name==='DB').id='other';await assert.rejects(f.adapter.prepare(),/PAUSE/);assert.equal(f.writes.length,0);
});
