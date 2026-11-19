const {test}=require('node:test'),assert=require('node:assert/strict');
const {deploymentHandoff,prepare}=require('./d1-resource-deployment-config.cjs');
const dbs=['e57d0931-18cb-4f00-ae7f-b0068030fb04','587bd210-6d9d-4f32-abb7-a490013e65d3'];
const names=['SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768'];
const indexes=target=>target?['videoq-prod-scenes-1536','videoq-prod-scenes-768']:['videoq-scenes-migration-v3-1536','videoq-scenes-migration-v3-768'];
function fixture(target=false){return{
 settings:{bindings:[{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'PERSISTENCE_BACKEND',type:'plain_text',text:'d1'},{name:'DB',type:'d1',id:dbs[Number(target)]},...names.map((name,i)=>({name,type:'vectorize',index_name:indexes(target)[i]}))]},
 config:{name:'videoq-api',main:'/artifact/index.js',vars:{DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',OTHER:'kept'},d1_databases:[{binding:'DB',database_id:dbs[0],database_name:'videoq-d1-migration-staging-v4',migrations_dir:'drizzle-d1'}],vectorize:names.map((binding,i)=>({binding,index_name:indexes(false)[i]})),r2_buckets:[{binding:'VIDEOS_BUCKET',bucket_name:'videoq-media-prod'}]},
};}
test('ordinary upload follows the exact live source or promoted tuple and preserves unrelated config',()=>{
 const before=fixture();assert.deepEqual(deploymentHandoff(before.settings,before.config),before.config);
 const f=fixture(true),original=structuredClone(f.config),result=deploymentHandoff(f.settings,f.config);
 assert.equal(result.d1_databases[0].database_id,dbs[1]);assert.equal(result.d1_databases[0].database_name,'videoq-prod-db');assert.deepEqual(result.vectorize.map(v=>v.index_name),indexes(true));
 const normalized=structuredClone(result);normalized.d1_databases=original.d1_databases;normalized.vectorize=original.vectorize;assert.deepEqual(normalized,original);assert.deepEqual(f.config,original);
 assert.deepEqual(deploymentHandoff(f.settings,result),result);
 assert.throws(()=>deploymentHandoff(before.settings,result),/HANDOFF_REQUIRED/);
});
test('mixed, unknown, duplicated, conflicting or non-D1 state cannot retarget a deployment',()=>{
 for(const change of [
 f=>{f.settings.bindings.find(v=>v.name==='DB').id='unreviewed';},
 f=>{f.settings.bindings.find(v=>v.name==='DB').database_id=dbs[0];},
 f=>{f.settings.bindings.find(v=>v.name===names[0]).index_name=indexes(false)[0];},
 f=>{f.settings.bindings.push(f.settings.bindings[0]);},
 f=>{f.settings.bindings.find(v=>v.name==='PERSISTENCE_BACKEND').text='postgres';},
 f=>{f.config.d1_databases[0].database_name='other';},
 f=>{f.config.vectorize.push(f.config.vectorize[0]);},
 ]){const f=fixture(true);change(f);assert.throws(()=>deploymentHandoff(f.settings,f.config),/HANDOFF_REQUIRED/);}
 const paused=fixture(true);paused.settings.bindings.push({name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'});assert.throws(()=>deploymentHandoff(paused.settings,paused.config),/CONTROLLED_RESUME/);
});
test('handoff metadata is fixed-account GET only and independent guard remains immediately before upload',async()=>{
 const f=fixture(true);let reads=0;
 await assert.rejects(prepare(f.config,{CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32)},()=>assert.fail('network ran')),/ACCOUNT_REQUIRED/);
 const result=await prepare(f.config,{CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'synthetic'},async(url,options)=>{
  reads++;assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(url.endsWith('/workers/scripts/videoq-api/settings'));return Response.json({success:true,result:f.settings});
 });assert.equal(reads,1);assert.equal(result.d1_databases[0].database_id,dbs[1]);
 const workflow=require('node:fs').readFileSync('.github/workflows/cd.yml','utf8');
 assert.match(workflow,/node \.github\/scripts\/d1-resource-deployment-config\.cjs deployment\.json\s+node \.github\/scripts\/protect-api-deployment\.cjs deployment\.json\s+node \.github\/deploy-tools\/node_modules\/wrangler\/bin\/wrangler\.js deploy/);
});

test('completed production deployment preserves the retired 768 index without permitting source or partial retirement',()=>{
 function retired(){const f=fixture(true);f.config=deploymentHandoff(f.settings,f.config);f.settings.bindings=f.settings.bindings.filter(v=>v.name!==names[1]);f.config.vectorize=f.config.vectorize.filter(v=>v.binding!==names[1]);return f;}
 const f=retired();assert.deepEqual(deploymentHandoff(f.settings,f.config),f.config);
 for(const change of [
  f=>f.settings.bindings.push({name:names[1],type:'vectorize',index_name:indexes(true)[1]}),
  f=>f.config.vectorize.push({binding:names[1],index_name:indexes(true)[1]}),
  f=>{f.settings.bindings.find(v=>v.name==='DB').id=dbs[0];},
  f=>{f.config.d1_databases[0].database_id=dbs[0];},
  f=>{f.config.d1_databases[0].database_name='other';},
  f=>{f.settings.bindings.find(v=>v.name===names[0]).index_name='other';},
  f=>{f.config.vectorize[0].index_name='other';},
  f=>{f.config.vectorize=[];},
  f=>{f.config.vectorize.push(f.config.vectorize[0]);},
  f=>{f.settings.bindings.push({name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'});},
 ]){const q=retired();change(q);assert.throws(()=>deploymentHandoff(q.settings,q.config));}
 const source=fixture();source.settings.bindings=source.settings.bindings.filter(v=>v.name!==names[1]);source.config.vectorize=source.config.vectorize.slice(0,1);assert.throws(()=>deploymentHandoff(source.settings,source.config),/HANDOFF_REQUIRED/);
});
