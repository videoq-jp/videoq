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
test('bound Cloudflare workers cannot migrate with only an API pause and caller acknowledgement',async()=>{
 const f=fixture();f.production.workflows=[{binding:'SEARCH_INDEX_WORKFLOW',name:'videoq-search-index-prod'}];
 await assert.rejects(runCanonicalMigration(f.options),/BACKGROUND_QUEUE_LIST/);assert.equal(f.calls.length,0);
});
test('migration verifies paused background resources before and after schema execution',async()=>{
 for(const reopen of [false,true]){
  const f=fixture();f.production.workflows=[{binding:'SEARCH_INDEX_WORKFLOW',name:'videoq-search-index-prod'}];
  const queues=['account','search'].map((kind,i)=>({queue_id:String(i+1).repeat(32),queue_name:`videoq-${kind}-prod`,modified_on:'2020-01-01T00:00:00Z',settings:{message_retention_period:345600,delivery_paused:true},consumers:[{type:'worker',script_name:'videoq-api',dead_letter_queue:`videoq-${kind}-dlq-prod`}]}));
  const workflows=[{id:'job-one',version_id:'11111111-2222-4333-8444-555555555555',status:'paused'}];
  f.options.fetcher=async(url,options)=>{
   assert.equal(options.method,'GET');
   if(url.includes('/workers/'))return Response.json({success:true,result:f.settings});
   if(url.includes('/workflows/'))return Response.json({success:true,result:workflows});
   if(url.includes('/queues?'))return Response.json({success:true,result:queues});
   const row=queues.find(row=>url.endsWith('/'+row.queue_id));assert.ok(row);return Response.json({success:true,result:row});
  };
  f.options.execute=(...args)=>{f.calls.push(args);if(reopen)workflows[0].status='running';};
  if(reopen)await assert.rejects(runCanonicalMigration(f.options),/WORKFLOW_PAUSE_REQUIRED/);
  else assert.equal((await runCanonicalMigration(f.options)).application_paused,true);
  assert.equal(f.calls.length,1);
 }
});

function noOpFixture(names=['0000_initial.sql']){
 const f=fixture();f.env.MAINTENANCE_WRITERS_STOPPED='false';f.state.lock.input.S=JSON.stringify({source_sha:SOURCE,kind:'migration',writers_stopped:false});f.production.vars.MIGRATION_TRAFFIC_STATE='running';
 f.settings.bindings=[{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'PERSISTENCE_BACKEND',type:'plain_text',text:'d1'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'running'},{name:'DB',type:'d1',id:f.production.d1_databases[0].database_id},...f.production.vectorize.map(v=>({name:v.binding,type:'vectorize',index_name:v.index_name}))];
 f.options.readMigrations=()=>['0000_initial.sql'];f.options.fetcher=async(url,options)=>{if(url.endsWith('/query')){assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{sql:'SELECT name FROM d1_migrations ORDER BY name LIMIT 501',params:[]});return Response.json({success:true,result:[{success:true,results:names.map(name=>({name}))}]});}return Response.json({success:true,result:f.settings});};return f;
}
test('ordinary D1 code deployment with an exact applied ledger performs no schema write or forced pause',async()=>{
 const f=noOpFixture(),r=await runCanonicalMigration(f.options);assert.equal(r.read_only,true);assert.equal(r.migrations_pending,false);assert.equal(f.calls.length,0);assert.equal(f.settings.bindings.find(b=>b.name==='MIGRATION_TRAFFIC_STATE').text,'running');
});
test('ordinary CD never reads the dedicated control credential even with background maintenance opted in',async()=>{
 const f=noOpFixture();f.env.VIDEOQ_BACKGROUND_MAINTENANCE='true';f.production.workflows=[{binding:'SEARCH_INDEX_WORKFLOW',name:'videoq-search-index-prod'}];
 assert.equal((await runCanonicalMigration(f.options)).read_only,true);assert.deepEqual(f.parameters,['/videoq/security/prod/d1-migration']);assert.equal(f.calls.length,0);
});
test('pending, duplicate or unknown migration ledgers cannot authorize an unpaused schema change',async()=>{
 for(const names of [[],['0000_initial.sql','9999_future.sql'],['0000_initial.sql','0000_initial.sql']]){const f=noOpFixture(names);await assert.rejects(runCanonicalMigration(f.options));assert.equal(f.calls.length,0);}
});
test('ledger errors, wrong active DB and ownership drift fail closed without a child or PostgreSQL fallback',async()=>{
 for(const change of [f=>{f.settings.bindings.find(b=>b.name==='DB').id='other';},f=>{f.options.fetcher=async()=>new Response('',{status:403});},f=>{const old=f.options.fetcher;f.options.fetcher=async(...args)=>{const result=await old(...args);if(args[0].endsWith('/query'))f.state.lock.execution_arn.S='other';return result;};}]){const f=noOpFixture();change(f);await assert.rejects(runCanonicalMigration(f.options));assert.equal(f.calls.length,0);}
});

test('production configuration and read-only migration support retirement of the optional 768 index',async()=>{
 const f=noOpFixture();
 f.production.vectorize=f.production.vectorize.filter(b=>b.binding!=='SCENE_VECTORIZE_768');
 f.settings.bindings=f.settings.bindings.filter(b=>b.name!=='SCENE_VECTORIZE_768');
 assert.equal(migrationTarget(f.options.readConfig()).backend,'d1');
 assert.equal((await runCanonicalMigration(f.options)).read_only,true);
 assert.equal(f.calls.length,0);
 for(const index of [undefined,'']) {
  const q=noOpFixture();q.production.vectorize[1].index_name=index;
  assert.throws(()=>migrationTarget(q.options.readConfig()),/CONFIGURATION/);
 }
 f.production.vectorize=[];
 assert.throws(()=>migrationTarget(f.options.readConfig()),/CONFIGURATION/);
 const source=require('node:fs').readFileSync('apps/api/wrangler.jsonc','utf8');
 const production=source.slice(source.indexOf('\"production\": {'));
 const indexes=production.match(/\"vectorize\"\s*:\s*(\[[\s\S]*?\])/);
 assert.ok(indexes);
 assert.deepEqual(JSON.parse(indexes[1]),[{binding:'SCENE_VECTORIZE_768',index_name:'videoq-prod-scenes-embeddinggemma2-768'}]);
 assert.match(production, /"EMBEDDING_MODEL": "@cf\/google\/embeddinggemma-2"/);
 assert.match(production, /"EMBEDDING_PROVIDER": "workers-ai"/);
 assert.match(production, /"EMBEDDING_PROFILE": "embeddinggemma2"/);
 assert.doesNotMatch(production, /"AI_PROVIDER"/);
});

test('canonical native production migration requires active 768 and supports retired 1536',()=>{
 const f=fixture();const config=f.options.readConfig();
 const p=config.env.production;Object.assign(p.vars,{EMBEDDING_PROVIDER:'workers-ai',EMBEDDING_PROFILE:'embeddinggemma2',EMBEDDING_MODEL:'@cf/google/embeddinggemma-2'});
 p.vectorize=[{binding:'SCENE_VECTORIZE_768',index_name:'videoq-prod-scenes-embeddinggemma2-768'}];
 assert.equal(migrationTarget(config).backend,'d1');
 config.env.production.vectorize=[];assert.throws(()=>migrationTarget(config),/CONFIGURATION/);
});

function managedFixture(){
 const f=fixture();let time=Date.parse('2026-11-22T15:00:00Z');
 f.env.VIDEOQ_BACKGROUND_MAINTENANCE='true';f.production.workflows=[{binding:'SEARCH_INDEX_WORKFLOW',name:'videoq-search-index-prod'}];
 const queues=['account','search'].map((kind,i)=>({queue_id:String(i+1).repeat(32),queue_name:`videoq-${kind}-prod`,modified_on:'2020-01-01T00:00:00Z',settings:{message_retention_period:345600,delivery_paused:i===1},consumers:[{type:'worker',script_name:'videoq-api',dead_letter_queue:`videoq-${kind}-dlq-prod`}]}));
 const workflows=['running','paused'].map((status,i)=>({id:'job-'+i,version_id:'11111111-2222-4333-8444-555555555555',status})),mutations=[];
 f.options.now=()=>time;f.options.sleep=async ms=>{time+=ms;};
 f.options.readParameter=name=>{f.parameters.push(name);return{CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:name.endsWith('background-maintenance')?'background-control-token-0123456789':'d1-migration-token-0123456789'};};
 f.options.aws=(service,command,input)=>{
  assert.equal(service,'dynamodb');
  if(command==='get-item')return{Item:structuredClone(input.Key.pk.S==='maintenance'?f.state.lock:f.state.row)};
  assert.equal(command,'transact-write-items');const [check,update]=input.TransactItems;
  assert.equal(check.ConditionCheck.ExpressionAttributeValues[':input'].S,f.state.lock.input.S);
  assert.equal(check.ConditionCheck.ExpressionAttributeValues[':execution'].S,f.state.lock.execution_arn.S);
  const field=update.Update.ExpressionAttributeNames['#record'];assert.equal(f.state.row[field],undefined);
  f.state.row[field]=structuredClone(update.Update.ExpressionAttributeValues[':record']);return{};
 };
 f.options.fetcher=async(url,options)=>{
  if(url.includes('/workers/')){assert.equal(options.method,'GET');return Response.json({success:true,result:f.settings});}
  assert.equal(options.headers.authorization,'Bearer background-control-token-0123456789');
  if(options.method==='GET')return Response.json({success:true,result:url.includes('/workflows/')?workflows:url.includes('/queues?')?queues:queues.find(row=>url.endsWith('/'+row.queue_id))});
  assert.equal(options.method,'PATCH');const body=JSON.parse(options.body);mutations.push({url,body});
  if(url.includes('/workflows/'))workflows.find(row=>url.endsWith('/'+row.id+'/status')).status=body.status==='pause'?'paused':'running';
  else{const row=queues.find(row=>url.endsWith('/'+row.queue_id));Object.assign(row.settings,body.settings);row.modified_on=new Date(time).toISOString();}
  return Response.json({success:true});
 };
 return{...f,queues,workflows,mutations};
}
test('opt-in migration persists originals, drains consumers, pauses Workflows and restores only after schema success',async()=>{
 const f=managedFixture();await runCanonicalMigration(f.options);assert.equal(f.calls.length,1);
 assert.deepEqual(f.queues.map(row=>row.settings.delivery_paused),[false,true]);assert.deepEqual(f.workflows.map(row=>row.status),['running','paused']);
 assert.ok(f.state.row.background_schema_complete);assert.ok(f.state.row.background_restore);
 assert.equal(f.calls[0][2].env.CLOUDFLARE_API_TOKEN,'d1-migration-token-0123456789');
 const count=f.mutations.length;await runCanonicalMigration(f.options);assert.equal(f.calls.length,1);assert.equal(f.mutations.length,count);
});
test('schema failure preserves pause and the same run can retry and restore its saved originals',async()=>{
 const f=managedFixture(),execute=f.options.execute;f.options.execute=()=>{throw Error('schema failed');};
 await assert.rejects(runCanonicalMigration(f.options),/schema failed/);assert.ok(f.queues.every(row=>row.settings.delivery_paused));assert.ok(f.workflows.every(row=>row.status==='paused'));assert.equal(f.state.row.background_schema_complete,undefined);
 const original=f.state.row.background_queues.S;f.options.execute=execute;await runCanonicalMigration(f.options);
 assert.equal(f.state.row.background_queues.S,original);assert.deepEqual(f.queues.map(row=>row.settings.delivery_paused),[false,true]);
});
