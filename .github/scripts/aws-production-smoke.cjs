// Fixed AWS smoke entry. Backend detection is opt-in until the narrow role
// permissions and persistent synthetic-identity key have been provisioned.
const {execFileSync}=require('node:child_process');
const {resolve,join}=require('node:path');
const m=require('./neon-admin.cjs');
const {readDeploymentSettings}=require('./protect-api-deployment.cjs');
const {smokeBackend}=require('./production-smoke-store.cjs');
const {createResourceSmokeGuard}=require('./d1-resource-smoke-guard.cjs');
async function runProductionSmoke({env=process.env,root=resolve(__dirname,'../..'),readParameter=m.readParameter,fetcher=fetch,execute=execFileSync,metadataAws=async(service,command,input)=>m.aws(service==='ddb'?'dynamodb':'stepfunctions',({GetItem:'get-item',DescribeExecution:'describe-execution',DescribeStateMachineForExecution:'describe-state-machine-for-execution'})[command],input)}={}){
 if(env.MAINTENANCE_STAGE!=='smoke'||env.MAINTENANCE_TABLE!=='videoq-db-maintenance-prod'||!/^[a-f0-9]{32}$/.test(env.MAINTENANCE_RUN_ID??'')||!['smoke','rotate','rollback','deploy'].includes(env.MAINTENANCE_KIND)||env.GITHUB_ACTIONS||!/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-smoke-prod:[a-f0-9-]{36}$/.test(env.CODEBUILD_BUILD_ARN??''))throw Error('AWS_SMOKE_CONTEXT_REQUIRED');
 const guard=createResourceSmokeGuard({env,aws:metadataAws});await guard.wait();
 let backend={backend:'postgres'},cf;
 if(env.VIDEOQ_D1_PRODUCTION_SMOKE==='true'){
  cf=readParameter('/videoq/security/prod/d1-migration');
  if(cf.CLOUDFLARE_ACCOUNT_ID!=='12daec56fdba43f677f2766ee26a5a39'||typeof cf.CLOUDFLARE_API_TOKEN!=='string'||cf.CLOUDFLARE_API_TOKEN.length<20||cf.CLOUDFLARE_API_TOKEN.length>4096||/[\r\n\0]/.test(cf.CLOUDFLARE_API_TOKEN))throw Error('INVALID_SMOKE_CONTROL_CREDENTIAL');
  backend=smokeBackend(await readDeploymentSettings(cf,fetcher));
 }else if(env.VIDEOQ_D1_PRODUCTION_SMOKE!==undefined&&env.VIDEOQ_D1_PRODUCTION_SMOKE!=='false')throw Error('INVALID_SMOKE_BACKEND_MODE');
 if(backend.backend==='postgres'&&env.VIDEOQ_D1_RESOURCE_SMOKE==='true')throw Error('RESOURCE_SMOKE_D1_BACKEND_REQUIRED');
 if(backend.backend==='postgres'){
  execute('python3',[join(root,'.github/scripts/with-neon-credentials.py'),'smoke','node',join(root,'.github/scripts/production-smoke.mjs')],{cwd:root,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,env:{...env,VIDEOQ_SMOKE_BACKEND:'postgres',OPERATION:'audit',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'videoq-jp/videoq',VIDEOQ_BUNDLED_CHROMIUM:'true'}});
  return{backend:'postgres'};
 }
 await guard.assert();
 const identity=readParameter('/videoq/security/prod/smoke-identity');
 if(!/^[a-f0-9]{64}$/.test(identity.key??''))throw Error('INVALID_SMOKE_IDENTITY_KEY');
 const child=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));
 Object.assign(child,{VIDEOQ_SMOKE_BACKEND:'d1',VIDEOQ_SMOKE_D1_DATABASE_ID:backend.databaseId,VIDEOQ_SMOKE_IDENTITY_KEY:identity.key,CLOUDFLARE_ACCOUNT_ID:cf.CLOUDFLARE_ACCOUNT_ID,CLOUDFLARE_API_TOKEN:cf.CLOUDFLARE_API_TOKEN,VIDEOQ_BUNDLED_CHROMIUM:'true',VERIFY_AI_ANSWERS:env.VERIFY_AI_ANSWERS==='true'?'true':'false'});
 await guard.assert();
 execute(process.execPath,[join(root,'.github/scripts/production-smoke.mjs')],{cwd:root,env:child,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout:20*60*1000});
 await guard.assert();
 return{backend:'d1'};
}
module.exports={runProductionSmoke};
