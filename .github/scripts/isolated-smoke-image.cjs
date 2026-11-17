// Match the existing deployed worker image without retrieving environment,
// application credentials or a code-download URL. This is a deployment
// baseline check, not a cryptographic source/provenance attestation.
const {execFile}=require('node:child_process'),{promisify}=require('node:util'),path=require('node:path');
const {executionEnv}=require('./run-cutover-admission.cjs');
const FUNCTIONS=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'];
function createDeployedWorkerImageCheck({imageDigest,env=process.env,root=path.resolve(__dirname,'../..'),execute=promisify(execFile)}){
 if(!/^[a-f0-9]{64}$/.test(imageDigest??''))throw Error('ISOLATED_IMAGE_DIGEST_REQUIRED');
 const expected='257240362763.dkr.ecr.ap-northeast-1.amazonaws.com/videoq-worker-prod@sha256:'+imageDigest;
 return async()=>{
  try{
   const rows=await Promise.all(FUNCTIONS.map(async name=>{
    const result=await execute('aws',['lambda','get-function','--function-name',name,'--region','ap-northeast-1','--no-cli-pager','--output','json','--query','{name:Configuration.FunctionName,role:Configuration.Role,state:Configuration.State,update:Configuration.LastUpdateStatus,package:Configuration.PackageType,architectures:Configuration.Architectures,image:Code.ResolvedImageUri}'],{cwd:root,env:executionEnv(env,'aws'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:65536});
    const row=JSON.parse(result.stdout);if(row.name!==name||row.role!=='arn:aws:iam::257240362763:role/videoq-worker-prod'||row.state!=='Active'||row.update!=='Successful'||row.package!=='Image'||row.architectures?.join(',')!=='arm64'||row.image!==expected)throw Error('drift');return true;
   }));
   if(rows.length!==3)throw Error('incomplete');return{matchesDeployedWorkerImage:true};
  }catch{throw Error('ISOLATED_DEPLOYED_IMAGE_CHECK_FAILED');}
 };
}
module.exports={createDeployedWorkerImageCheck};
