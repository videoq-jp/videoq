// Fixed main-only request caller; never reads database credentials.
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const actions={status:'cutover-status',start:'cutover-hold',release:'release-cutover-hold',recover:'recover-cutover-hold','prepare-consumers':'prepare-cutover-consumers','pause-consumers':'pause-cutover-consumers','resume-consumers':'resume-cutover-consumers','retry-consumers':'retry-cutover-consumers','inspect-activity':'inspect-cutover-activity','retry-activity':'retry-cutover-activity'};
function request(env){
 if(env.GITHUB_REPOSITORY!=='videoq-jp/videoq'||env.GITHUB_REF!=='refs/heads/main')throw Error('PRODUCTION_MAIN_ONLY');
 if(!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA??''))throw Error('INVALID_MIGRATION_SOURCE');
 if(!Object.hasOwn(actions,env.OPERATION))throw Error('INVALID_CUTOVER_OPERATION');
 const run=env.CUTOVER_RUN_ID??'';
 if(env.OPERATION==='start'){
  if(run||!/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID??''))throw Error('INVALID_CUTOVER_START');
  const token=createHash('sha256').update('videoq-cutover-hold:v1:'+env.GITHUB_RUN_ID).digest('hex').slice(0,32);
  return{args:['cutover-hold'],token};
 }
 if(!/^[a-f0-9]{32}$/.test(run))throw Error('INVALID_CUTOVER_RUN_ID');
 return{args:[actions[env.OPERATION],'--run-id',run]};
}
function runRequest({env=process.env,execute=execFileSync}={}){
 const selected=request(env);
 const childEnv={...env};delete childEnv.CUTOVER_HOLD_REQUEST_TOKEN;
 if(selected.token)childEnv.CUTOVER_HOLD_REQUEST_TOKEN=selected.token;
 return execute('python3',['.github/scripts/run-aws-db.py',...selected.args],{stdio:'inherit',env:childEnv});
}
module.exports={request,runRequest};
if(require.main===module){try{if(process.argv.length!==2)throw Error('UNEXPECTED_ARGUMENT');runRequest();}catch(error){console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'FIXED_CUTOVER_REQUEST_FAILED');process.exitCode=1;}}
