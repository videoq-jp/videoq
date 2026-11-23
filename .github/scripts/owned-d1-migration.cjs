// Shared D1 execution policy; admission is supplied by the AWS or Cloudflare owner.
const {join}=require('node:path');
const {assertDeploymentPreservesState,readDeploymentSettings}=require('./protect-api-deployment.cjs');
const {assertBackgroundMigrationFence,createBackgroundMigrationReadTransport,backgroundBindingsPresent}=require('./background-migration-fence.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
async function runOwnedD1Migration({env,root,target,run,source,assertOwnership,readCredential,createMaintenance,execute,fetcher,now,sleep,readMigrations,verificationOnly=false,verifyMaintenance}){
  if(!['true','false'].includes(env.MAINTENANCE_WRITERS_STOPPED))throw Error('INVALID_MIGRATION_WRITER_STATE');
  const ownership=assertOwnership;
  await ownership();
  const secret=await readCredential('migration');
  if(secret.CLOUDFLARE_ACCOUNT_ID!==ACCOUNT||typeof secret.CLOUDFLARE_API_TOKEN!=='string'||secret.CLOUDFLARE_API_TOKEN.length<20||secret.CLOUDFLARE_API_TOKEN.length>4096||/[\r\n\0]/.test(secret.CLOUDFLARE_API_TOKEN)) throw Error('INVALID_D1_MIGRATION_CREDENTIAL');
  const cf={CLOUDFLARE_ACCOUNT_ID:ACCOUNT,CLOUDFLARE_API_TOKEN:secret.CLOUDFLARE_API_TOKEN};
  const settings=await readDeploymentSettings(cf,fetcher);
  assertDeploymentPreservesState(settings,target.production);
  if(verificationOnly){
    if(env.MAINTENANCE_WRITERS_STOPPED!=='false'||env.VIDEOQ_BACKGROUND_MAINTENANCE!=='true'||!backgroundBindingsPresent(target.production,settings))throw Error('BACKGROUND_VERIFICATION_CONTEXT_REQUIRED');
    const assertProducerAdmissionClosed=async()=>{
      await ownership();const current=await readDeploymentSettings(cf,fetcher);assertDeploymentPreservesState(current,target.production);
      for(const [name,expected] of [['ACCOUNT_JOB_BACKEND','sqs'],['SEARCH_JOB_BACKEND','sqs'],['DEPLOYMENT_EDITION','cloud'],['PERSISTENCE_BACKEND','d1']]){
        const values=current.bindings.filter(row=>row.name===name);
        if(values.length!==1||values[0].type!=='plain_text'||values[0].text!==expected)throw Error('BACKGROUND_VERIFICATION_SQS_ROUTING_REQUIRED');
      }
      const traffic=current.bindings.filter(row=>row.name==='MIGRATION_TRAFFIC_STATE');
      if(traffic.length>1||traffic.length===1&&(traffic[0].type!=='plain_text'||traffic[0].text!=='running'))throw Error('BACKGROUND_VERIFICATION_RUNNING_API_REQUIRED');
      await ownership();
    };
    await assertProducerAdmissionClosed();
    await verifyMaintenance({run,source,credential:await readCredential('background'),fetcher,assertOwnership:ownership,assertProducerAdmissionClosed,now,sleep});
    return{backend:'d1',source_sha:source,read_only:true,background_verified:true};
  }
  if(env.MAINTENANCE_WRITERS_STOPPED==='false'){
    // Ordinary code-only CD may inspect an already active D1. It cannot create
    // or migrate a DB, change backend, or infer a writer stop from an empty diff.
    const actual=settings.bindings.find(b=>b.name==='PERSISTENCE_BACKEND')?.text??(settings.bindings.find(b=>b.name==='DEPLOYMENT_EDITION')?.text==='cloud'?'d1':'postgres');
    if(actual!=='d1')throw Error('D1_MIGRATION_REQUIRES_DRAINED_WRITERS');
    const expected=readMigrations();
    if(!Array.isArray(expected)||!expected.length||expected.length>500||new Set(expected).size!==expected.length||expected.some(n=>typeof n!=='string'||!/^\d{4}_[a-z0-9_]+\.sql$/.test(n)))throw Error('INVALID_D1_MIGRATION_INVENTORY');
    const id=target.production.d1_databases[0].database_id;
    const response=await fetcher('https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+id+'/query',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+secret.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},body:JSON.stringify({sql:'SELECT name FROM d1_migrations ORDER BY name LIMIT 501',params:[]})});
    if(!response.ok||!response.body)throw Error('D1_MIGRATION_LEDGER_UNAVAILABLE');
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>128*1024)throw Error('D1_MIGRATION_LEDGER_UNAVAILABLE');chunks.push(Buffer.from(chunk));}
    let ledger;try{ledger=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('D1_MIGRATION_LEDGER_UNAVAILABLE');}
    const rows=ledger?.result?.[0]?.results;
    if(ledger?.success!==true||ledger.result?.length!==1||ledger.result[0].success!==true||!Array.isArray(rows)||rows.length>500||rows.some(r=>!r||Object.keys(r).join(',')!=='name'||typeof r.name!=='string'))throw Error('D1_MIGRATION_LEDGER_UNAVAILABLE');
    const names=rows.map(r=>r.name);
    if(new Set(names).size!==names.length||names.some(n=>!expected.includes(n)))throw Error('D1_MIGRATION_LEDGER_DIVERGED');
    if(JSON.stringify(names.toSorted())!==JSON.stringify(expected.toSorted()))throw Error('D1_MIGRATION_REQUIRES_DRAINED_WRITERS');
    await ownership();const after=await readDeploymentSettings(cf,fetcher);assertDeploymentPreservesState(after,target.production);
    const selected=after.bindings.find(b=>b.name==='PERSISTENCE_BACKEND')?.text??(after.bindings.find(b=>b.name==='DEPLOYMENT_EDITION')?.text==='cloud'?'d1':'postgres');
    if(selected!=='d1')throw Error('D1_MIGRATION_BACKEND_CHANGED');
    return{backend:'d1',source_sha:source,read_only:true,migrations_pending:false};
  }
  const pause=settings.bindings.filter(binding=>binding.name==='MIGRATION_TRAFFIC_STATE');
  if(pause.length!==1||pause[0].type!=='plain_text'||pause[0].text!=='paused') throw Error('D1_MIGRATION_REQUIRES_PAUSED_API');
  let maintenance;
  if(env.VIDEOQ_BACKGROUND_MAINTENANCE==='true'&&backgroundBindingsPresent(target.production,settings)){
    maintenance=createMaintenance({run,source,credential:await readCredential('background'),fetcher,assertOwnership:ownership,now,sleep,
      assertApiPaused:async()=>{
        await ownership();const current=await readDeploymentSettings(cf,fetcher);assertDeploymentPreservesState(current,target.production);
        if(current.bindings.find(row=>row.name==='MIGRATION_TRAFFIC_STATE')?.text!=='paused')throw Error('D1_MIGRATION_PAUSE_CHANGED');
      }});
    // A retry after a committed schema command resumes only background control;
    // never re-baseline original pauses or re-run an unrecorded inverse action.
    if(await maintenance.completed()){await maintenance.restore();return{backend:'d1',source_sha:source,application_paused:true,background_restored:true};}
    await maintenance.pause();
  }
  const backgroundRequest=maintenance?.request??createBackgroundMigrationReadTransport({token:secret.CLOUDFLARE_API_TOKEN,fetcher});
  await assertBackgroundMigrationFence({production:target.production,settings,request:backgroundRequest,now});
  await ownership();
  const childEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));
  Object.assign(childEnv,cf,{CI:'true',WRANGLER_SEND_METRICS:'false'});
  execute(process.execPath,[join(root,'.github/deploy-tools/node_modules/wrangler/bin/wrangler.js'),'d1','migrations','apply','DB','--remote','--config',join(root,'apps/api/wrangler.jsonc'),'--env','production','--env-file','/dev/null'],
    {cwd:root,env:childEnv,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout:900000});
  await ownership();
  // A failure retains application pause; never reopen traffic here.
  const after=await readDeploymentSettings(cf,fetcher);
  assertDeploymentPreservesState(after,target.production);
  if(after.bindings.find(binding=>binding.name==='MIGRATION_TRAFFIC_STATE')?.text!=='paused') throw Error('D1_MIGRATION_PAUSE_CHANGED');
  await assertBackgroundMigrationFence({production:target.production,settings:after,request:backgroundRequest,now});
  if(maintenance){await maintenance.markComplete();await maintenance.restore();}
  return {backend:'d1',source_sha:source,application_paused:true,...(maintenance?{background_restored:true}:{})};
}
module.exports={runOwnedD1Migration};
