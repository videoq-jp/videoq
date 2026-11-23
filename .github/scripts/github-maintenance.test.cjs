const test=require('node:test'),assert=require('node:assert/strict');
const {runGithubMaintenance}=require('./github-maintenance.cjs');
const {createClient,context}=require('./cloudflare-maintenance-client.cjs');
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'videoq-jp/videoq',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),GITHUB_WORKFLOW_SHA:'a'.repeat(40),ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'oidc-only',GH_MAINTENANCE_READ_TOKEN:'github-read-token',CLOUDFLARE_MAINTENANCE_TOKEN:'synthetic-cloudflare-token-0123456789',SMOKE_IDENTITY_KEY:'b'.repeat(64),AWS_SECRET_ACCESS_KEY:'never-forward',NODE_OPTIONS:'never-forward',DATABASE_URL:'never-forward',PATH:'/synthetic/bin',VERIFY_AI_ANSWERS:'true'};
function fixture(){const events=[];return{events,owner:{run:'c'.repeat(32),source:env.GITHUB_SHA,plans:{},acquire:async()=>({state:'running'}),assert:async()=>events.push('assert'),finish:async value=>events.push({finish:value}),fail:async()=>events.push('fail')}};}
test('GitHub smoke runs the existing guarded D1 smoke and drops AWS/OIDC/process injection credentials',async()=>{
 const f=fixture(),calls=[];const settings={bindings:[{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'DB',type:'d1',id:'373d6ca5-2796-460d-8ab1-e644de46bb3c'}]};
 const result=await runGithubMaintenance({kind:'smoke',env,root:'/synthetic',ownerFactory:async()=>f.owner,fetcher:async()=>Response.json({success:true,result:settings}),execute:(...args)=>calls.push(args),readReport:()=>({status:'ok'})});assert.equal(result.syntheticCleanupComplete,true);assert.equal(calls.length,1);const child=calls[0][2].env;for(const key of ['AWS_SECRET_ACCESS_KEY','NODE_OPTIONS','DATABASE_URL','ACTIONS_ID_TOKEN_REQUEST_TOKEN','GH_MAINTENANCE_READ_TOKEN'])assert.equal(child[key],undefined);assert.equal(child.VIDEOQ_SMOKE_IDENTITY_KEY,env.SMOKE_IDENTITY_KEY);assert.equal(child.VERIFY_AI_ANSWERS,'true');assert.deepEqual(f.events.at(-1),{finish:{syntheticCleanupComplete:true}});
});
test('failed or incomplete smoke never records completion or releases its durable lock',async()=>{
 const f=fixture();await assert.rejects(runGithubMaintenance({kind:'smoke',env,ownerFactory:async()=>f.owner,fetcher:async()=>Response.json({success:true,result:{bindings:[]}}),execute:()=>assert.fail('child must not execute')}),/D1_MAINTENANCE_REQUIRED/);assert.equal(f.events.at(-1),'fail');assert.equal(f.events.some(x=>x.finish),false);
});
test('failed admission reads no runtime credentials and starts no child',async()=>{
 await assert.rejects(runGithubMaintenance({kind:'smoke',env:{},ownerFactory:async()=>({...fixture().owner,acquire:async()=>{throw Error('MAINTENANCE_BUSY');}}),execute:()=>assert.fail('child')}),/MAINTENANCE_BUSY/);
});
test('completed and released attempts reconcile lost final responses without repeating side effects',async()=>{
 for(const state of ['released','completed']){let released=0;const f=fixture();f.owner.acquire=async()=>({state});f.owner.request=async body=>{assert.equal(body.action,'release');released++;};assert.equal((await runGithubMaintenance({kind:'smoke',env:{},ownerFactory:async()=>f.owner,execute:()=>assert.fail('child')})).alreadyCompleted,true);assert.equal(released,state==='completed'?1:0);}
});
test('client renews short-lived OIDC and retries the exact request after a lost response',async()=>{
 const {runKey}=await import('../../infra/cloudflare-maintenance/coordinator.mjs');assert.equal(context('smoke',env).run,await runKey({kind:'smoke',runId:'123'}));let tokens=0,requests=0;const bodies=[];
 const fetcher=async(url,options)=>{
  if(String(url).includes('pipelines.actions')){tokens++;assert.equal(new URL(url).searchParams.get('audience'),'videoq-maintenance-prod');return Response.json({value:'signed-token-'+tokens});}
  assert.equal(url,'https://videoq-maintenance-prod.yukiharada1228.workers.dev/v1/smoke');assert.equal(options.headers['x-github-token'],env.GH_MAINTENANCE_READ_TOKEN);bodies.push(options.body);requests++;if(requests===1)throw Error('lost response');return Response.json({state:'running'});
 };
 const client=await createClient({kind:'smoke',env,fetcher,sleep:async()=>{}});await client.acquire(false);assert.equal(tokens,2);assert.equal(bodies[0],bodies[1]);assert.equal(bodies[0].includes(env.GH_MAINTENANCE_READ_TOKEN),false);
});
test('client refuses non-GitHub, branch, workflow SHA and nonpositive attempt contexts',()=>{
 for(const changes of [{GITHUB_ACTIONS:'false'},{GITHUB_REPOSITORY:'other/repo'},{GITHUB_REF:'refs/heads/dev'},{GITHUB_WORKFLOW_SHA:'b'.repeat(40)},{GITHUB_RUN_ATTEMPT:'0'},{GITHUB_RUN_ID:'0'}])assert.throws(()=>context('smoke',{...env,...changes}),/CONTEXT/);
});
test('GitHub migration validates the existing D1 ledger without a schema command or AWS context',async()=>{
 const {readdirSync}=require('node:fs'),{resolve}=require('node:path');const f=fixture(),root=resolve(__dirname,'../..');
 const names=readdirSync(resolve(root,'apps/api/drizzle-d1')).filter(n=>n.endsWith('.sql')).sort();
 const production={name:'videoq-api',vars:{ENVIRONMENT:'production',DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1'},d1_databases:[{binding:'DB',database_name:'synthetic',database_id:'11111111-2222-4333-8444-555555555555',migrations_dir:'drizzle-d1'}],vectorize:[{binding:'SCENE_VECTORIZE_1536',index_name:'synthetic-1536'},{binding:'SCENE_VECTORIZE_768',index_name:'synthetic-768'}]};
 for(const pending of [false,true]){
  f.events.length=0;const options={kind:'migration',env,root,ownerFactory:async()=>f.owner,readConfig:()=>({env:{production}}),execute:()=>assert.fail('ordinary CD must not apply schema'),fetcher:async(url,options)=>{
   if(String(url).endsWith('/query')){assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).sql,'SELECT name FROM d1_migrations ORDER BY name LIMIT 501');return Response.json({success:true,result:[{success:true,results:(pending?names.slice(1):names).map(name=>({name}))}]});}
   return Response.json({success:true,result:{bindings:[{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'PERSISTENCE_BACKEND',type:'plain_text',text:'d1'},{name:'DB',type:'d1',id:production.d1_databases[0].database_id},...production.vectorize.map(row=>({name:row.binding,type:'vectorize',index_name:row.index_name}))]}});
  }};
  if(pending){await assert.rejects(runGithubMaintenance(options),/D1_MIGRATION_REQUIRES_DRAINED_WRITERS/);assert.equal(f.events.at(-1),'fail');}
  else{assert.equal((await runGithubMaintenance(options)).read_only,true);assert.deepEqual(f.events.at(-1),{finish:{readOnly:true}});}
 }
});
test('GitHub migration refuses a PostgreSQL selection rather than invoking the old credential wrapper',async()=>{
 const f=fixture();await assert.rejects(runGithubMaintenance({kind:'migration',env,ownerFactory:async()=>f.owner,readConfig:()=>({env:{production:{name:'videoq-api',vars:{ENVIRONMENT:'production'}}}}),execute:()=>assert.fail('no legacy child')}),/D1_MAINTENANCE_REQUIRED/);assert.equal(f.events.at(-1),'fail');
});
test('a smoke child returning an incomplete cleanup report cannot release ownership',async()=>{
 const f=fixture();await assert.rejects(runGithubMaintenance({kind:'smoke',env,ownerFactory:async()=>f.owner,fetcher:async()=>Response.json({success:true,result:{bindings:[{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'DB',type:'d1',id:'373d6ca5-2796-460d-8ab1-e644de46bb3c'}]}}),execute:()=>{},readReport:()=>({status:'failed'})}),/PRODUCTION_VERIFICATION_FAILED/);assert.equal(f.events.at(-1),'fail');assert.equal(f.events.some(x=>x.finish),false);
});
