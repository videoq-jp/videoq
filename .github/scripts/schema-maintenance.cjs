// Fixed, owned D1 schema maintenance. Phase-specific credentials stay in their
// protected environments; plans and receipts contain no credential values.
const {resolve,join}=require('node:path');
const {readFileSync,readdirSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
const {createClient}=require('./cloudflare-maintenance-client.cjs');
const {createApiTrafficControl,createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs');
const {verifyProductionTraffic}=require('./cutover-owned-api-traffic.cjs');
const {migrationTarget}=require('./migration-backend.cjs');
const {runOwnedD1Migration}=require('./owned-d1-migration.cjs');
const {createCanonicalBackgroundMaintenance}=require('./canonical-background-maintenance.cjs');
const {backgroundBindingsPresent}=require('./background-migration-fence.cjs');
const {readDeploymentSettings}=require('./protect-api-deployment.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39',DRAIN_MS=16*60*1000;
function credential(env,name){const token=env[name];if(typeof token!=='string'||token.length<20||token.length>4096||/[\r\n\0]/.test(token))throw Error('SCHEMA_MAINTENANCE_CREDENTIAL_REQUIRED');return{CLOUDFLARE_ACCOUNT_ID:ACCOUNT,CLOUDFLARE_API_TOKEN:token};}
function config(root){const errors=[],value=require(join(root,'.github/deploy-tools/node_modules/jsonc-parser')).parse(readFileSync(join(root,'apps/api/wrangler.jsonc'),'utf8'),errors);if(errors.length)throw Error('INVALID_MIGRATION_CONFIGURATION');return value;}
async function schemaMaintenance({phase,env=process.env,root=resolve(__dirname,'../..'),ownerFactory=createClient,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),trafficFactory=createApiTrafficControl,verifyTraffic=verifyProductionTraffic,migrate=runOwnedD1Migration,readConfig=()=>config(root),execute=execFileSync,maintenanceFactory=createCanonicalBackgroundMaintenance,readSettings=readDeploymentSettings}={}){
 if(!['admit','pause','migrate','resume'].includes(phase)||env.GITHUB_JOB!==phase||env.GITHUB_WORKFLOW_REF!=='videoq-jp/videoq/.github/workflows/schema-maintenance.yml@refs/heads/main')throw Error('SCHEMA_MAINTENANCE_CONTEXT_REQUIRED');
 const owner=await ownerFactory({kind:'migration',env,fetcher});
 let admission;
 if(phase==='admit'&&env.PREVIOUS_MIGRATION_RUN){
  const previous={runId:env.PREVIOUS_MIGRATION_RUN,source:env.PREVIOUS_MIGRATION_SOURCE,attempt:Number(env.PREVIOUS_MIGRATION_ATTEMPT)};
  admission=await owner.request({action:'recover-readonly',previous});
 }else admission=await owner.acquire(true);
 if(admission.state==='released')return{alreadyCompleted:true};
 if(admission.state==='completed'){await owner.request({action:'release'});return{alreadyCompleted:true};}
 try{
  await owner.assert();
  if(phase==='admit')return{admitted:true};
  const proof=()=>({version:1,run:owner.run,source:owner.source});
  const matches=value=>value?.version===1&&value.run===owner.run&&value.source===owner.source;
  const plan=await owner.plans.load('api-traffic-plan');
  if(phase==='pause'){
   const cf=credential(env,'CLOUDFLARE_API_TOKEN');
   const traffic=trafficFactory(createCloudflareTrafficTransport(cf.CLOUDFLARE_API_TOKEN,{fetcher}),{assertOwnership:()=>owner.assert()});
   const saved=plan??await traffic.prepare({purpose:'production'});
   if(!plan)await owner.plans.save('api-traffic-plan',saved);
   await traffic.change(saved,true);await verifyTraffic(true,fetcher);await owner.assert();
   const checkpoint=await owner.plans.load('api-traffic-paused');
   if(checkpoint!==null&&!matches(checkpoint))throw Error('SCHEMA_PAUSE_PROOF_REQUIRED');
   if(checkpoint===null)await owner.plans.save('api-traffic-paused',{...proof(),pausedAt:now()});
   return{applicationPaused:true};
  }
  const paused=await owner.plans.load('api-traffic-paused');
  if(!plan||!matches(paused)||!Number.isSafeInteger(paused.pausedAt)||paused.pausedAt>now())throw Error('SCHEMA_PAUSE_PROOF_REQUIRED');
  if(phase==='migrate'){
   const cf=credential(env,'CLOUDFLARE_MAINTENANCE_TOKEN');
   const target=migrationTarget(readConfig());if(target.backend!=='d1')throw Error('D1_MAINTENANCE_REQUIRED');
   // This dedicated workflow owns the pause. Ordinary CD cannot supply this
   // override or reopen paused traffic; the normal preservation checks still run.
   target.production={...target.production,vars:{...target.production.vars,MIGRATION_TRAFFIC_STATE:'paused'}};
   const assertPaused=async()=>{await owner.assert();const current=await readSettings(cf,fetcher);if(current.bindings.filter(b=>b.name==='MIGRATION_TRAFFIC_STATE'&&b.type==='plain_text'&&b.text==='paused').length!==1)throw Error('SCHEMA_API_PAUSE_REQUIRED');return current;};
   const drain=async()=>{
    await assertPaused();await verifyTraffic(true,fetcher);
    while(now()-paused.pausedAt<DRAIN_MS){await sleep(Math.min(5000,DRAIN_MS-(now()-paused.pausedAt)));await assertPaused();}
    await assertPaused();await verifyTraffic(true,fetcher);
    const receipt=await owner.plans.load('api-traffic-drained');
    if(receipt!==null&&(!matches(receipt)||receipt.pausedAt!==paused.pausedAt))throw Error('SCHEMA_DRAIN_PROOF_REQUIRED');
    if(receipt===null)await owner.plans.save('api-traffic-drained',{...proof(),pausedAt:paused.pausedAt,minimumDrainMs:DRAIN_MS});
   };
   const settings=await assertPaused();
   if(!backgroundBindingsPresent(target.production,settings))await drain();
   const result=await migrate({env:{...env,MAINTENANCE_WRITERS_STOPPED:'true',VIDEOQ_BACKGROUND_MAINTENANCE:'true'},root,target,run:owner.run,source:owner.source,assertOwnership:()=>owner.assert(),readCredential:purpose=>purpose==='migration'?cf:credential(env,'CLOUDFLARE_BACKGROUND_TOKEN'),createMaintenance:options=>{
    const maintenance=maintenanceFactory({...options,store:owner.plans});
    return{...maintenance,async pause(){await maintenance.pause();await drain();}};
   },execute,fetcher,now,sleep,readMigrations:()=>readdirSync(join(root,'apps/api/drizzle-d1')).filter(name=>name.endsWith('.sql')).sort()});
   if(result.application_paused!==true||backgroundBindingsPresent(target.production,settings)&&result.background_restored!==true)throw Error('SCHEMA_COMPLETION_PROOF_REQUIRED');
   await assertPaused();await owner.plans.save('schema-maintenance-result',{...proof(),schemaCompleted:true,backgroundRestored:true});
   return{schemaCompleted:true,applicationPaused:true};
  }
  const result=await owner.plans.load('schema-maintenance-result');
  if(!matches(result)||result.schemaCompleted!==true||result.backgroundRestored!==true)throw Error('SCHEMA_COMPLETION_PROOF_REQUIRED');
  const cf=credential(env,'CLOUDFLARE_API_TOKEN');
  const assertRestoreSafe=async()=>{await owner.assert();const saved=await owner.plans.load('schema-maintenance-result');if(!matches(saved)||saved.schemaCompleted!==true||saved.backgroundRestored!==true)throw Error('SCHEMA_COMPLETION_PROOF_REQUIRED');};
  const traffic=trafficFactory(createCloudflareTrafficTransport(cf.CLOUDFLARE_API_TOKEN,{fetcher}),{assertOwnership:()=>owner.assert(),assertRestoreSafe});
  await traffic.change(plan,false);await verifyTraffic(false,fetcher);await owner.assert();
  await owner.plans.save('api-traffic-resumed',{...proof(),applicationReadyVerified:true});
  await owner.finish({backgroundRestored:true,apiTrafficRestored:true});return{schemaCompleted:true,applicationReady:true};
 }catch(error){await owner.fail().catch(()=>{});throw error;}
}
if(require.main===module)schemaMaintenance({phase:process.argv[2]}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(/^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message??'')?error.message:'SCHEMA_MAINTENANCE_FAILED');process.exitCode=1;});
module.exports={schemaMaintenance,DRAIN_MS};
