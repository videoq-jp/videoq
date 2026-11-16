const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceApiAdapters}=require('./d1-resource-api.cjs');
function fixture(){
 const plans=new Map(),writes=[],settings={bindings:[{name:'DB',type:'d1',id:'source'},{name:'SECRET',type:'secret_text'}],compatibility_date:'2026-08-20'};let proof=null;
 const request=async(method,path,body)=>{if(method==='GET'){if(path.endsWith('/deployments'))return{deployments:[{id:'11111111-1111-1111-1111-111111111111',versions:[{version_id:'22222222-2222-2222-2222-222222222222',percentage:100}]}]};if(path.endsWith('/versions?per_page=1'))return{items:[{id:'22222222-2222-2222-2222-222222222222'}]};return structuredClone(settings);}assert.equal(method,'PATCH');writes.push(body);settings.bindings=body.bindings.map(b=>b.type==='inherit'?settings.bindings.find(v=>v.name===b.name):b);};
 const options={request,plans:{load:async key=>plans.get(key)??null},assertOwnership:async()=>{},verifiedBackendHandoff:async()=>proof};
 return{settings,plans,writes,options,adapters:createResourceApiAdapters(options),context:{assertOwnership:async()=>{}},verify:hash=>proof={bindingsHash:hash}};
}
async function paused(f){const plan=await f.adapters['pause-api'].prepare();f.plans.set('pause-api',plan);await f.adapters['pause-api'].apply(plan,f.context);return plan;}
test('API pause saves original plan and restoration requires verified backend proof',async()=>{
 const f=fixture(),plan=await paused(f);assert.equal((await f.adapters['pause-api'].probe(plan)).state,'applied');await assert.rejects(f.adapters['resume-api'].prepare(),/HANDOFF/);f.verify(plan.bindingsHash);const resumed=await f.adapters['resume-api'].prepare();assert.equal((await f.adapters['resume-api'].probe(resumed)).state,'not-applied');await f.adapters['resume-api'].apply(resumed,f.context);assert.equal((await f.adapters['resume-api'].probe(resumed)).state,'applied');assert.ok(f.writes.every(w=>w.bindings.filter(b=>b.name!=='MIGRATION_TRAFFIC_STATE').every(b=>b.type==='inherit')));
});
test('a changed backend cannot resume using source proof or a substituted original plan',async()=>{
 const f=fixture(),plan=await paused(f);f.settings.bindings[0].id='unverified-target';f.verify(plan.bindingsHash);await assert.rejects(f.adapters['resume-api'].prepare(),/MISMATCH/);const bad={...plan,originalTraffic:'running'};await assert.rejects(f.adapters['resume-api'].apply(bad,f.context),/ORIGINAL_PLAN/);assert.equal(f.writes.length,1);
});
test('proof withdrawal and private plan loss refuse resume before mutation',async()=>{
 const f=fixture(),plan=await paused(f);f.verify(plan.bindingsHash);const resume=await f.adapters['resume-api'].prepare();f.options.verifiedBackendHandoff=async()=>null;const a=createResourceApiAdapters(f.options);await assert.rejects(a['resume-api'].apply(resume,f.context),/HANDOFF/);f.plans.clear();await assert.rejects(f.adapters['resume-api'].apply(resume,f.context));assert.equal(f.writes.length,1);
});
test('verified target binding hash resumes the promoted backend while source plan remains immutable',async()=>{
 const {resourceDigest}=require('./d1-resource-journal.cjs'),f=fixture(),source=await paused(f);f.settings.bindings[0].id='verified-target';const hash=resourceDigest(f.settings.bindings.filter(b=>b.name!=='MIGRATION_TRAFFIC_STATE'));f.verify(hash);const plan=await f.adapters['resume-api'].prepare();assert.equal(plan.bindingsHash,hash);assert.notEqual(plan.bindingsHash,source.bindingsHash);await assert.rejects(f.adapters['pause-api'].probe(source),/CONFIGURATION_CHANGED/);await f.adapters['resume-api'].apply(plan,f.context);assert.equal((await f.adapters['resume-api'].probe(plan)).state,'applied');assert.equal(f.plans.get('pause-api').bindingsHash,source.bindingsHash);assert.equal(f.settings.bindings[0].id,'verified-target');
});
