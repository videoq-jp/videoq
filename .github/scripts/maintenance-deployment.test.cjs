const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs'),{tmpdir}=require('node:os'),{join}=require('node:path');
const {deploymentConfig}=require('./maintenance-deployment.cjs');
test('maintenance upload config preserves the fixed worker and SQLite namespace while rejecting ambiguous switches',()=>{
 const artifact=mkdtempSync(join(tmpdir(),'maintenance-upload-'));
 try{
  writeFileSync(join(artifact,'worker.js'),'export default {};');
  // An artifact must not choose its worker name, bindings or activation state.
  writeFileSync(join(artifact,'wrangler.json'),JSON.stringify({name:'attacker',vars:{MAINTENANCE_ENABLED:'true'}}));
  const config=deploymentConfig({artifact,enabled:'false'});
  assert.equal(config.name,'videoq-maintenance-prod');assert.equal(config.main,join(artifact,'worker.js'));assert.equal(config.no_bundle,true);assert.deepEqual(config.vars,{MAINTENANCE_ENABLED:'false'});assert.deepEqual(config.migrations,[{tag:'v1',new_sqlite_classes:['MaintenanceCoordinator']}]);assert.deepEqual(config.durable_objects.bindings,[{name:'MAINTENANCE',class_name:'MaintenanceCoordinator'}]);
  for(const enabled of [undefined,'','TRUE','1','false --var OTHER:true'])assert.throws(()=>deploymentConfig({artifact,enabled}),/INVALID_MAINTENANCE_SWITCH/);
 }finally{rmSync(artifact,{recursive:true,force:true});}
});
test('production maintenance credentials are confined to the two protected purpose jobs',()=>{
 const {readFileSync}=require('node:fs');
 for(const [name,allowed,environment] of [['cd','db-migrate','production-db-migration'],['operations','smoke','production-db-smoke']]){
  const text=readFileSync(join(__dirname,'../workflows',name+'.yml'),'utf8');
  const jobs=[...text.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)];let found=0;
  for(let i=0;i<jobs.length;i++){
   const block=text.slice(jobs[i].index,jobs[i+1]?.index??text.length);
   if(!block.includes('secrets.CLOUDFLARE_MAINTENANCE_TOKEN'))continue;
   found++;assert.equal(jobs[i][1],allowed);assert.match(block,new RegExp('environment: '+environment));assert.match(block,/if: vars\.CLOUDFLARE_MAINTENANCE_ENABLED == 'true'/);
  }
  assert.equal(found,1);
 }
});
