// Canonical-main GitHub entry. It never manufactures CodeBuild/Step Functions
// context; admission and immutable plans are owned by the Cloudflare coordinator.
const {resolve,join}=require('node:path');
const {readFileSync,readdirSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
const {createClient}=require('./cloudflare-maintenance-client.cjs');
const {migrationTarget}=require('./migration-backend.cjs');
const {runOwnedD1Migration}=require('./owned-d1-migration.cjs');
const {createCanonicalBackgroundMaintenance}=require('./canonical-background-maintenance.cjs');
const {readDeploymentSettings}=require('./protect-api-deployment.cjs');
const {smokeBackend}=require('./production-smoke-store.cjs');
const {runOwnedD1Smoke}=require('./owned-production-smoke.cjs');
const {assertProductionSmoke}=require('./production-smoke-result.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
function credential(env,name){
 const value=env[name];if(typeof value!=='string'||value.length<20||value.length>4096||/[\r\n\0]/.test(value))throw Error('MAINTENANCE_CREDENTIAL_REQUIRED');
 return{CLOUDFLARE_ACCOUNT_ID:ACCOUNT,CLOUDFLARE_API_TOKEN:value};
}
async function runGithubMaintenance({kind,env=process.env,root=resolve(__dirname,'../..'),fetcher=fetch,execute=execFileSync,ownerFactory=createClient,readConfig,readReport=()=>JSON.parse(readFileSync(join(root,'operations-report.json'),'utf8'))}={}){
 if(!['migration','smoke'].includes(kind))throw Error('INVALID_MAINTENANCE_KIND');
 if(!['','0','1'].includes(env.STRUCTURED_ANSWER_WRITERS_STOPPED??''))throw Error('INVALID_WRITER_STATE');
 const writersStopped=kind==='migration'&&env.STRUCTURED_ANSWER_WRITERS_STOPPED==='1';
 const owner=await ownerFactory({kind,env,fetcher});
 const admission=await owner.acquire(writersStopped);
 if(admission.state==='released')return{alreadyCompleted:true};
 if(admission.state==='completed'){await owner.request({action:'release'});return{alreadyCompleted:true};}
 try{
  const cf=credential(env,'CLOUDFLARE_MAINTENANCE_TOKEN');
  if(kind==='smoke'){
   const backend=smokeBackend(await readDeploymentSettings(cf,fetcher));
   if(backend.backend!=='d1')throw Error('D1_MAINTENANCE_REQUIRED');
   await runOwnedD1Smoke({env,root,cf,backend,readIdentity:()=>({key:env.SMOKE_IDENTITY_KEY}),assertOwnership:()=>owner.assert(),execute});
   assertProductionSmoke(readReport());await owner.assert();
   await owner.finish({syntheticCleanupComplete:true});return{backend:'d1',syntheticCleanupComplete:true};
  }
  const config=readConfig?readConfig():(()=>{const errors=[];const value=require(join(root,'.github/deploy-tools/node_modules/jsonc-parser')).parse(readFileSync(join(root,'apps/api/wrangler.jsonc'),'utf8'),errors);if(errors.length)throw Error('INVALID_MIGRATION_CONFIGURATION');return value;})();
  const target=migrationTarget(config);if(target.backend!=='d1')throw Error('D1_MAINTENANCE_REQUIRED');
  const result=await runOwnedD1Migration({env:{...env,MAINTENANCE_WRITERS_STOPPED:String(writersStopped),VIDEOQ_BACKGROUND_MAINTENANCE:'true'},root,target,run:owner.run,source:owner.source,assertOwnership:()=>owner.assert(),readCredential:purpose=>purpose==='migration'?cf:credential(env,'CLOUDFLARE_BACKGROUND_TOKEN'),createMaintenance:options=>createCanonicalBackgroundMaintenance({...options,store:owner.plans}),execute,fetcher,now:Date.now,readMigrations:()=>readdirSync(join(root,'apps/api/drizzle-d1')).filter(name=>name.endsWith('.sql')).sort()});
  await owner.assert();await owner.finish(writersStopped?{backgroundRestored:result.background_restored===true}:{readOnly:result.read_only===true});return result;
 }catch(error){await owner.fail().catch(()=>{});throw error;}
}
if(require.main===module)runGithubMaintenance({kind:process.argv[2]}).then(result=>console.log(JSON.stringify({status:'complete',...result}))).catch(error=>{const safe=/^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message??'')?error.message:'GITHUB_MAINTENANCE_FAILED';console.error(safe);process.exitCode=1;});
module.exports={runGithubMaintenance};
