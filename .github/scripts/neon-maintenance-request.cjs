// Main-only GitHub request selection. This caller never reads DB credentials.
const {execFileSync}=require('node:child_process');
function requestArgs(env){
 if(env.GITHUB_REPOSITORY!=='videoq-jp/videoq'||env.GITHUB_REF!=='refs/heads/main')throw Error('PRODUCTION_MAIN_ONLY');
 if(!['audit','rotate','rollback'].includes(env.OPERATION))throw Error('INVALID_MAINTENANCE_OPERATION');
 const inspection=env.AUDIT_INSPECTION??'none';
 if(inspection==='none')return[env.OPERATION];
 if(inspection!=='postgres-login-fence'||env.OPERATION!=='audit')throw Error('INVALID_AUDIT_INSPECTION');
 return['audit','--inspection','postgres-login-fence'];
}
function runRequest({env=process.env,execute=execFileSync}={}){
 return execute('python3',['.github/scripts/run-aws-db.py',...requestArgs(env)],{stdio:'inherit'});
}
module.exports={requestArgs,runRequest};
if(require.main===module){try{if(process.argv.length!==2)throw Error('UNEXPECTED_ARGUMENT');runRequest();}catch(error){console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'FIXED_MAINTENANCE_REQUEST_FAILED');process.exitCode=1;}}
