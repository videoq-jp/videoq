const test=require('node:test'),assert=require('node:assert/strict');
const {schemaMaintenance,DRAIN_MS}=require('./schema-maintenance.cjs');
function fixture(){
 const source='b'.repeat(40),run='1'.repeat(32),plans=new Map(),events=[];let time=1000,paused=false,failed=false,released=false;
 const owner={run,source,request:async body=>{events.push(body);return{state:'running'};},acquire:async writers=>{assert.equal(writers,true);return{state:released?'released':'running'};},assert:async()=>{},plans:{load:async key=>plans.get(key)??null,save:async(key,value)=>{if(plans.has(key))assert.deepEqual(plans.get(key),value);plans.set(key,structuredClone(value));}},fail:async()=>{failed=true;},finish:async proof=>{assert.equal(proof.apiTrafficRestored,true);assert.equal(paused,false);released=true;}};
 const env={GITHUB_WORKFLOW_REF:'videoq-jp/videoq/.github/workflows/schema-maintenance.yml@refs/heads/main',CLOUDFLARE_API_TOKEN:'api-fixture-token-xxxxxxxx',CLOUDFLARE_MAINTENANCE_TOKEN:'d1-fixture-token-xxxxxxxx',CLOUDFLARE_BACKGROUND_TOKEN:'background-fixture-token-xxxxxxxx'};
 const options={env,ownerFactory:async()=>owner,now:()=>time,sleep:async ms=>{events.push('wait');time+=ms;},readConfig:()=>({}),readSettings:async()=>({bindings:[{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:paused?'paused':'running'},{name:'ACCOUNT_JOBS',type:'queue'}]}),verifyTraffic:async value=>{assert.equal(paused,value);events.push(value?'probe-paused':'probe-ready');},trafficFactory:(_request,guards)=>({prepare:async()=>({synthetic:true}),change:async(_plan,value)=>{await guards.assertOwnership();if(!value)await guards.assertRestoreSafe();paused=value;events.push(value?'pause':'resume');}}),maintenanceFactory:()=>({pause:async()=>{events.push('background-pause');},completed:async()=>false,markComplete:async()=>{},restore:async()=>{events.push('background-restore');}}),execute:()=>{assert.equal(paused,true);assert.ok(time>=1000+DRAIN_MS);assert.ok(plans.has('api-traffic-drained'));events.push('schema');}};
 options.readConfig=()=>({env:{production:{name:'videoq-api',vars:{ENVIRONMENT:'production',DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1'},d1_databases:[{binding:'DB',database_name:'videoq-prod',database_id:'11111111-2222-4333-8444-555555555555',migrations_dir:'drizzle-d1'}],vectorize:[{binding:'SCENE_VECTORIZE_1536',index_name:'fixture-1536'}]}}});
 options.migrate=async input=>{
  assert.equal(input.env.MAINTENANCE_WRITERS_STOPPED,'true');assert.equal(input.target.production.vars.MIGRATION_TRAFFIC_STATE,'paused');
  const maintenance=input.createMaintenance({});await maintenance.pause();input.execute();await maintenance.restore();return{application_paused:true,background_restored:true};
 };
 return{options,owner,env,plans,events,get failed(){return failed;},get paused(){return paused;},get released(){return released;},phase:phase=>schemaMaintenance({...options,phase,env:{...env,GITHUB_JOB:phase}})};
}
test('owned phases persist pause, drain before schema and restore only after verified completion',async()=>{
 const f=fixture();f.env.PREVIOUS_MIGRATION_RUN='123';f.env.PREVIOUS_MIGRATION_SOURCE='a'.repeat(40);f.env.PREVIOUS_MIGRATION_ATTEMPT='1';
 assert.equal((await f.phase('admit')).admitted,true);assert.deepEqual(f.events[0],{action:'recover-readonly',previous:{runId:'123',source:'a'.repeat(40),attempt:1}});
 await f.phase('pause');assert.equal(f.paused,true);await f.phase('migrate');assert.equal(f.paused,true);assert.equal(f.released,false);
 assert.equal((await f.phase('resume')).applicationReady,true);assert.equal(f.released,true);assert.equal(f.failed,false);
 assert.ok(f.events.indexOf('background-pause')<f.events.indexOf('schema'));assert.ok(f.events.indexOf('schema')<f.events.indexOf('background-restore'));assert.ok(f.events.indexOf('background-restore')<f.events.indexOf('resume'));
 assert.doesNotMatch(JSON.stringify([...f.plans]),/fixture-token/);
 assert.deepEqual(await f.phase('resume'),{alreadyCompleted:true});
});
test('schema and resume cannot run without pause and completion proofs',async()=>{
 for(const phase of ['migrate','resume']){const f=fixture();await assert.rejects(f.phase(phase),/PAUSE_PROOF_REQUIRED/);assert.equal(f.failed,true);assert.equal(f.released,false);assert.ok(!f.events.includes('schema'));}
 const f=fixture();await f.phase('pause');await assert.rejects(f.phase('resume'),/COMPLETION_PROOF_REQUIRED/);assert.equal(f.paused,true);assert.equal(f.released,false);
});
test('schema failure retains pause and ownership and never resumes traffic',async()=>{
 const f=fixture();await f.phase('pause');f.options.execute=()=>{throw Error('SYNTHETIC_SCHEMA_FAILURE');};
 await assert.rejects(f.phase('migrate'),/SYNTHETIC_SCHEMA_FAILURE/);assert.equal(f.paused,true);assert.equal(f.failed,true);assert.equal(f.released,false);assert.equal(f.plans.has('schema-maintenance-result'),false);assert.ok(!f.events.includes('resume'));
});
test('changed pause metadata or lost pause stops the schema command',async()=>{
 for(const change of ['source','future','live']){const f=fixture();await f.phase('pause');
  if(change==='source')f.plans.get('api-traffic-paused').source='c'.repeat(40);
  if(change==='future')f.plans.get('api-traffic-paused').pausedAt=Number.MAX_SAFE_INTEGER;
  if(change==='live')f.options.readSettings=async()=>({bindings:[]});
  await assert.rejects(f.phase('migrate'));assert.ok(!f.events.includes('schema'));assert.equal(f.released,false);
 }
});
test('phase, workflow and ownership are checked before runtime credentials or mutations',async()=>{
 const f=fixture();await assert.rejects(schemaMaintenance({...f.options,phase:'pause',env:{...f.env,GITHUB_JOB:'migrate'}}),/CONTEXT_REQUIRED/);
 f.options.ownerFactory=async()=>{throw Error('SYNTHETIC_ADMISSION_REFUSED');};await assert.rejects(f.phase('pause'),/ADMISSION_REFUSED/);assert.equal(f.events.length,0);
});
