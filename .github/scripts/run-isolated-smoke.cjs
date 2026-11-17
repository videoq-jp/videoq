// Explicit local entry for an already provisioned isolated environment. No
// provisioning, credential regeneration, SSM, retry or infrastructure teardown.
const path=require('node:path'),{execFileSync}=require('node:child_process');
const {verifyReviewedSource}=require('./run-cutover-admission.cjs');
const {cloudflareToken}=require('./run-d1-resource-preflight.cjs');
const {loadIsolatedSmokeManifest,loadIsolatedSmokePins}=require('./isolated-smoke-manifest.cjs');
const {loadReviewedSmokeFixture}=require('./isolated-smoke-fixture.cjs');
const {runIsolatedSmoke}=require('./isolated-smoke-composition.cjs');
const {loadIsolatedSmokeTools}=require('./isolated-smoke-tools.cjs');
const ROOT=path.resolve(__dirname,'../..');
function parse(args){
 if(args.length!==6)throw Error('ISOLATED_SMOKE_ARGUMENTS_REQUIRED');const value={};
 for(let i=0;i<args.length;i+=2){if(!['--source','--manifest','--pins'].includes(args[i])||value[args[i]]!==undefined)throw Error('ISOLATED_SMOKE_ARGUMENTS_REQUIRED');value[args[i]]=args[i+1];}
 if(!/^[a-f0-9]{40}$/.test(value['--source']??'')||['--manifest','--pins'].some(k=>typeof value[k]!=='string'||!path.isAbsolute(value[k])||value[k].includes('\0')))throw Error('ISOLATED_SMOKE_ARGUMENTS_REQUIRED');
 return{source:value['--source'],manifestFile:value['--manifest'],pinsFile:value['--pins']};
}
async function main({args=process.argv.slice(2),env=process.env,execute=execFileSync,onStage=()=>{}}={}){
 const requested=parse(args);
 if(env.VIDEOQ_ISOLATED_SMOKE_ENABLED!=='true')throw Error('ISOLATED_SMOKE_DISABLED');
 if(env.GITHUB_ACTIONS||env.DATABASE_URL||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL)throw Error('ISOLATED_SMOKE_LOCAL_CONTEXT_REQUIRED');
 await verifyReviewedSource({source:requested.source,root:ROOT,env,execute});
 const manifest=loadIsolatedSmokeManifest(requested.manifestFile);
 const pins=loadIsolatedSmokePins(requested.pinsFile,{manifest,source:requested.source,identityKey:env.VIDEOQ_SMOKE_IDENTITY_KEY});
 const tools=await loadIsolatedSmokeTools(ROOT),fixtureBytes=loadReviewedSmokeFixture({source:requested.source,root:ROOT,execute,env});
 const token=cloudflareToken({env,execute,root:ROOT});
 return runIsolatedSmoke({source:requested.source,manifest,versions:pins.versions,imageDigest:pins.imageDigest,secretSha256:pins.secretSha256,env:{...env,CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:token,VIDEOQ_SMOKE_D1_DATABASE_ID:manifest.databaseId},...tools,fixtureBytes,onStage});
}
module.exports={parse,main};
if(require.main===module)main({onStage:({stage})=>console.log('ISOLATED_SMOKE_STAGE: '+stage)}).then(report=>{
 console.log(JSON.stringify(report));if(report.status!=='ok'||report.cleanupComplete!==true)process.exitCode=1;
}).catch(()=>{console.error('ISOLATED_SMOKE_FAILED: preserve private context and isolated resources for reconciliation; no automatic restart or infrastructure deletion was attempted.');process.exitCode=1;});
