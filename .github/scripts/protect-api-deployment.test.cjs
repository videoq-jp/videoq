const {test}=require('node:test'),assert=require('node:assert/strict');
const {assertDeploymentPreservesState:check,protect}=require('./protect-api-deployment.cjs');
const vectors=['SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768'];
const fixture=()=>({settings:{bindings:[{type:'plain_text',name:'DEPLOYMENT_EDITION',text:'cloud'}, {type:'plain_text',name:'PERSISTENCE_BACKEND',text:'d1'}, {type:'d1',name:'DB',id:'database'}, ...vectors.map(name=>({type:'vectorize',name,index_name:name+'-prod'}))]},target:{name:'videoq-api',vars:{DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1'},d1_databases:[{binding:'DB',database_id:'database'}],vectorize:vectors.map(name=>({binding:name,index_name:name+'-prod'}))}});
test('ordinary code updates preserve active D1 targets and reject rollback or retargeting',()=>{
 const {settings,target}=fixture();assert.deepEqual(check(settings,target),{deploymentStatePreserved:true});
 assert.throws(()=>check(settings,{...target,vars:{}}),/CONTROLLED_ROLLBACK/);
 assert.throws(()=>check(settings,{...target,d1_databases:[]}),/CONTROLLED_MIGRATION/);
 assert.throws(()=>check(settings,{...target,d1_databases:[{binding:'DB',database_id:'empty-database'}]}),/CONTROLLED_MIGRATION/);
 assert.throws(()=>check(settings,{...target,vectorize:[...target.vectorize,{binding:vectors[0],index_name:'duplicate'}]}),/CONTROLLED_MIGRATION/);
 assert.throws(()=>check(settings,{...target,vectorize:target.vectorize.map(v=>({...v,index_name:'other'}))}),/CONTROLLED_MIGRATION/);
});
test('a pause, including invalid configured state, cannot be cleared by ordinary CD',()=>{
 for(const value of ['paused','','false','typo']){
  const {settings,target}=fixture();settings.bindings.push({type:'plain_text',name:'MIGRATION_TRAFFIC_STATE',text:value});
  assert.throws(()=>check(settings,target),/CONTROLLED_RESUME/);
  assert.doesNotThrow(()=>check(settings,{...target,vars:{...target.vars,MIGRATION_TRAFFIC_STATE:'paused'}}));
 }
 assert.doesNotThrow(()=>check({bindings:[]},{name:'videoq-api',vars:{ENVIRONMENT:'production'}}));
});
test('missing or ambiguous state never bypasses the deployment check',()=>{
 const {settings,target}=fixture();assert.throws(()=>check({},target),/INVALID_DEPLOYMENT_STATE/);
 assert.throws(()=>check({...settings,bindings:[...settings.bindings,settings.bindings[0]]},target),/INVALID_DEPLOYMENT_STATE/);
 assert.throws(()=>check({bindings:[{name:'PERSISTENCE_BACKEND',type:'secret_text'}]},target),/INVALID_DEPLOYMENT_STATE/);
});
test('management read is fixed, credential-scoped, bounded and fail-closed',async()=>{
 const {settings,target}=fixture(),env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-token'};
 let calls=0;
 await protect(target,env,async(url,options)=>{calls++;assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+'/workers/scripts/videoq-api/settings');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');return Response.json({success:true,result:settings});});
 assert.equal(calls,1);
 await assert.rejects(protect(target,env,async()=>new Response('',{status:403})),/UNAVAILABLE/);
 await assert.rejects(protect(target,env,async()=>Response.json({success:false})),/UNAVAILABLE/);
 await assert.rejects(protect(target,env,async()=>new Response('x'.repeat(1024*1024+1))),/UNAVAILABLE/);
 await assert.rejects(protect(target,{...env,CLOUDFLARE_ACCOUNT_ID:'invalid'},async()=>{throw Error('must not fetch');}),/UNAVAILABLE/);
});
test('the credentialed API upload checks handoff, deployed state and embedding provenance before Terraform',()=>{
 const source=require('node:fs').readFileSync('.github/workflows/cd.yml','utf8');
 const api=source.slice(source.indexOf('  api-deploy:'),source.indexOf('  db-migrate:'));
 assert.match(api,/node \.github\/scripts\/d1-resource-deployment-config\.cjs deployment\.json\s+node \.github\/scripts\/protect-api-deployment\.cjs deployment\.json\s+node \.github\/scripts\/embedding-release-preflight\.cjs deployment\.json\s+node \.github\/scripts\/terraform-cloudflare-release\.cjs api deployment\.json/);
});

test('retired 768 binding may be absent on both sides without allowing additions or removal of active indexes',()=>{
 const {settings,target}=fixture();
 settings.bindings=settings.bindings.filter(b=>b.name!==vectors[1]);
 const retired={...target,vectorize:target.vectorize.slice(0,1)};
 assert.deepEqual(check(settings,retired),{deploymentStatePreserved:true});
 assert.throws(()=>check(settings,target),/VECTOR_TARGET_REQUIRES_CONTROLLED_MIGRATION/);
 const active=fixture();
 assert.throws(()=>check(active.settings,retired),/VECTOR_TARGET_REQUIRES_CONTROLLED_MIGRATION/);
 for(const bindings of [settings.bindings.filter(b=>b.name!==vectors[0]),[...settings.bindings,{name:vectors[1],type:'plain_text',text:'invalid'}],[...settings.bindings,settings.bindings.at(-1)]]) {
  assert.throws(()=>check({...settings,bindings},retired));
 }
 assert.throws(()=>check(settings,{...retired,vectorize:[]}),/VECTOR_TARGET_REQUIRES_CONTROLLED_MIGRATION/);
});
