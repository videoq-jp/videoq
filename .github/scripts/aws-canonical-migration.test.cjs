const {test}=require('node:test'),assert=require('node:assert/strict');
const {migrationTarget}=require('./migration-backend.cjs');
const {runCanonicalMigration}=require('./aws-canonical-migration.cjs');
const SOURCE='a'.repeat(40),RUN='b'.repeat(32),ARN='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+RUN;
function fixture(){
 const production={name:'videoq-api',vars:{ENVIRONMENT:'production',DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',MIGRATION_TRAFFIC_STATE:'paused'},d1_databases:[{binding:'DB',database_name:'copy',database_id:'11111111-2222-4333-8444-555555555555',migrations_dir:'drizzle-d1'}],vectorize:[{binding:'SCENE_VECTORIZE_1536',index_name:'copy-1536'},{binding:'SCENE_VECTORIZE_768',index_name:'copy-768'}]};
 const env={MAINTENANCE_KIND:'migration',MAINTENANCE_STAGE:'migration',MAINTENANCE_TABLE:'videoq-db-maintenance-prod',MAINTENANCE_RUN_ID:RUN,MAINTENANCE_SOURCE_SHA:SOURCE,MAINTENANCE_WRITERS_STOPPED:'true',CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-migration-prod:11111111-2222-4333-8444-555555555555',PATH:'/usr/bin',HOME:'/private/home',AWS_SECRET_ACCESS_KEY:'synthetic-aws',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-oidc',NODE_OPTIONS:'--require attacker',PGOPTIONS:'unsafe'};
 const settings={bindings:[{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'}]};
 const calls=[],parameters=[],state={lock:{kind:{S:'migration'},execution_arn:{S:ARN},input:{S:JSON.stringify({source_sha:SOURCE,kind:'migration',writers_stopped:true})}},row:{kind:{S:'migration'},execution_arn:{S:ARN}}};
 const options={env,root:'/canonical',operatorRoot:'/operator',readConfig:()=>({env:{production}}),aws:(service,command,value)=>{assert.equal(service,'dynamodb');assert.equal(command,'get-item');return {Item:value.Key.pk.S==='maintenance'?state.lock:state.row};},readParameter:name=>{parameters.push(name);return {CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'synthetic-token-01234567890123456789'};},fetcher:async()=>Response.json({success:true,result:settings}),execute:(...args)=>calls.push(args)};
 return {production,env,settings,calls,parameters,state,options};
}
test('canonical selection retains legacy PostgreSQL and refuses incomplete D1 without fallback',()=>{
 assert.equal(migrationTarget({env:{production:{name:'videoq-api',vars:{ENVIRONMENT:'production'}}}}).backend,'postgres');
 const f=fixture();assert.equal(migrationTarget(f.options.readConfig()).backend,'d1');
 for(const mutate of [p=>delete p.d1_databases,p=>p.d1_databases[0].database_id='00000000-0000-0000-0000-000000000000',p=>p.d1_databases[0].migrations_pattern='partial.sql',p=>p.vectorize[1].index_name=p.vectorize[0].index_name,p=>p.vars.MIGRATION_ALLOW_CLOUD_POSTGRES='true',p=>p.vars.DEPLOYMENT_EDITION='onprem']){
  const q=fixture();mutate(q.production);assert.throws(()=>migrationTarget(q.options.readConfig()),/CONFIGURATION/);
 }
});
test('D1 executes only the fixed Wrangler command with no AWS/OIDC/Node/PG credential inheritance',async()=>{
 const f=fixture(),result=await runCanonicalMigration(f.options);assert.equal(result.backend,'d1');assert.deepEqual(f.parameters,['/videoq/security/prod/d1-migration']);assert.equal(f.calls.length,1);
 const [command,args,options]=f.calls[0];assert.equal(command,process.execPath);assert.deepEqual(args,['/canonical/.github/deploy-tools/node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--remote','--config','/canonical/apps/api/wrangler.jsonc','--env','production','--env-file','/dev/null']);
 assert.equal(options.env.CI,'true');assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID,'12daec56fdba43f677f2766ee26a5a39');
 for(const key of ['AWS_SECRET_ACCESS_KEY','ACTIONS_ID_TOKEN_REQUEST_TOKEN','NODE_OPTIONS','PGOPTIONS'])assert.equal(options.env[key],undefined);
 assert.equal(options.stdio[1],'pipe');
});
test('PostgreSQL preserves its credential wrapper and never reads a Cloudflare secret',async()=>{
 const f=fixture();f.production.vars={ENVIRONMENT:'production'};assert.equal((await runCanonicalMigration(f.options)).backend,'postgres');assert.equal(f.parameters.length,0);assert.equal(f.calls[0][0],'python3');assert.deepEqual(f.calls[0][1],['/operator/.github/scripts/with-neon-credentials.py','migration','sh','apps/api/scripts/db-migrate.sh']);
});
test('missing pause, stopped-writer acknowledgement, lock ownership or source prevents any migration',async()=>{
 for(const mutate of [f=>f.settings.bindings=[],f=>f.settings.bindings[0].text='running',f=>f.env.MAINTENANCE_WRITERS_STOPPED='false',f=>f.state.lock.execution_arn.S='other',f=>f.state.lock.input.S=JSON.stringify({source_sha:'c'.repeat(40)}),f=>f.env.GITHUB_ACTIONS='true',f=>f.env.CODEBUILD_BUILD_ARN=f.env.CODEBUILD_BUILD_ARN.replace('migration-prod','rotation-prod')]){
  const f=fixture();mutate(f);await assert.rejects(runCanonicalMigration(f.options));assert.equal(f.calls.length,0);
 }
});
test('failed management reads and credential errors cannot fall back to PostgreSQL',async()=>{
 for(const mutate of [f=>f.options.fetcher=async()=>new Response('',{status:403}),f=>f.options.readParameter=()=>({}),f=>f.options.execute=()=>{throw Error('synthetic child failure');}]){
  const f=fixture();mutate(f);await assert.rejects(runCanonicalMigration(f.options));
 }
});
test('ownership and pause are checked again after child completion',async()=>{
 for(const mutate of [f=>f.state.lock.execution_arn.S='other',f=>f.settings.bindings[0].text='running']){
  const f=fixture();f.options.execute=(...args)=>{f.calls.push(args);mutate(f);};await assert.rejects(runCanonicalMigration(f.options));assert.equal(f.calls.length,1);
 }
});
