// Local metadata reader for only nonce-derived isolated resources. Provider
// responses stay in memory; this exposes no SSM, IAM, invoke, queue or code write.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {executionEnv}=require('./run-cutover-admission.cjs');
const {validateIsolatedSmokeManifest}=require('./isolated-smoke-target.cjs');
const GROUPS=['media','search','account'],ACCOUNT='257240362763',REGION='ap-northeast-1';
function createIsolatedAwsTransport({manifest,versions,env=process.env,root=path.resolve(__dirname,'../..'),execute=promisify(execFile),now=Date.now}){
 const context=Object.freeze(structuredClone(manifest)),target=validateIsolatedSmokeManifest(context,now());versions=Object.freeze({...versions});
 if(Object.keys(versions).sort().join(',')!=='account,media,search'||GROUPS.some(g=>!/^[1-9][0-9]{0,9}$/.test(versions[g]??'')))throw Error('ISOLATED_AWS_CONTEXT_REQUIRED');
 const prefix='videoq-isolated-'+target.nonce+'-',functions=GROUPS.map(g=>`arn:aws:lambda:${REGION}:${ACCOUNT}:function:${prefix}worker-${g}`),queues=GROUPS.flatMap(g=>[g,g+'-dlq']).map(g=>`https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${prefix}${g}`);
 const keys=(input,wanted)=>input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).sort().join(',')===[...wanted].sort().join(',');
 return async(service,command,input)=>{
  validateIsolatedSmokeManifest(context,now());let action;
  if(service==='sts'&&command==='GetCallerIdentity'&&keys(input,[]))action='get-caller-identity';
  if(service==='sqs'&&command==='GetQueueAttributes'&&keys(input,['QueueUrl','AttributeNames'])&&queues.includes(input.QueueUrl)&&JSON.stringify(input.AttributeNames)===JSON.stringify(['QueueArn','RedrivePolicy','Policy','VisibilityTimeout']))action='get-queue-attributes';
  if(service==='sqs'&&command==='ListQueueTags'&&keys(input,['QueueUrl'])&&queues.includes(input.QueueUrl))action='list-queue-tags';
  if(service==='lambda'&&command==='GetFunction'&&keys(input,['FunctionName','Qualifier'])&&functions.includes(input.FunctionName)&&input.Qualifier===versions[GROUPS[functions.indexOf(input.FunctionName)]])action='get-function';
  if(service==='lambda'&&command==='ListEventSourceMappings'&&keys(input,['FunctionName','MaxItems'])&&functions.includes(input.FunctionName)&&input.MaxItems===100)action='list-event-source-mappings';
  if(!action)throw Error('ISOLATED_AWS_READ_REFUSED');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'videoq-isolated-aws-read-')),file=path.join(directory,'input.json');
  try{
   await fs.writeFile(file,JSON.stringify(input),{mode:0o600});
   const result=await execute('aws',[service,action,'--region',REGION,'--no-cli-pager','--no-paginate','--output','json','--cli-input-json','file://'+file],{cwd:root,env:executionEnv(env,'aws'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:2*1024*1024});
   const value=JSON.parse(result.stdout);validateIsolatedSmokeManifest(context,now());return value;
  }catch{throw Error('ISOLATED_AWS_METADATA_UNAVAILABLE');}finally{await fs.rm(directory,{recursive:true,force:true});}
 };
}
module.exports={createIsolatedAwsTransport};
