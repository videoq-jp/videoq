// Operator authority, not the restricted GitHub request role. Reviewed main only.
const {execFileSync}=require('node:child_process');
const {mkdtempSync,writeFileSync,rmSync,realpathSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {createAdmissionOperator,ACTIONS}=require('./cutover-admission-operator.cjs');
const {createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs');
const {definition}=require('../../infra/db-maintenance/state-machine.cjs');
const {definitionHash}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
const ROOT=resolve(__dirname,'../..'),TABLE='videoq-db-maintenance-prod',MACHINE='arn:aws:states:ap-northeast-1:257240362763:stateMachine:videoq-db-maintenance-prod';
const select=(env,names)=>Object.fromEntries(names.filter(n=>typeof env[n]==='string').map(n=>[n,env[n]]));
function parse(args){
 if(args.length!==6)throw Error('INVALID_ADMISSION_ARGUMENTS');const o={};
 for(let i=0;i<args.length;i+=2){if(!['--action','--run','--source'].includes(args[i])||o[args[i]]!==undefined)throw Error('INVALID_ADMISSION_ARGUMENTS');o[args[i]]=args[i+1];}
 if(!ACTIONS.includes(o['--action'])||!/^[a-f0-9]{32}$/.test(o['--run']??'')||!/^[a-f0-9]{40}$/.test(o['--source']??''))throw Error('INVALID_ADMISSION_ARGUMENTS');
 return{action:o['--action'],run:o['--run'],source:o['--source']};
}
function executionEnv(env,kind){
 const common=['PATH','HOME','LANG','TMPDIR'];
 return select(env,[...common,...(kind==='github'?['GH_TOKEN','GITHUB_TOKEN','GH_CONFIG_DIR']:kind==='aws'?['AWS_PROFILE','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_WEB_IDENTITY_TOKEN_FILE','AWS_ROLE_ARN','AWS_ROLE_SESSION_NAME','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_CONTAINER_AUTHORIZATION_TOKEN','AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE']:[])]);
}
function run(execute,command,args,env,root){return execute(command,args,{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:4*1024*1024});}
async function verifyReviewedSource({source,root=ROOT,execute=execFileSync,env=process.env}){
 if(!/^[a-f0-9]{40}$/.test(source??''))throw Error('INVALID_ADMISSION_SOURCE');
 const git=args=>run(execute,'git',args,executionEnv(env,'git'),root).trim();
 if(git(['rev-parse','HEAD'])!==source||git(['status','--porcelain','--untracked-files=all'])||realpathSync(git(['rev-parse','--show-toplevel']))!==realpathSync(root)||!['https://github.com/videoq-jp/videoq.git','git@github.com:videoq-jp/videoq.git'].includes(git(['remote','get-url','origin'])))throw Error('CLEAN_CANONICAL_SOURCE_REQUIRED');
 const read=(path,projection)=>JSON.parse(run(execute,'gh',['api','--hostname','github.com',path,'--jq',projection],executionEnv(env,'github'),root));
 const repository=read('repos/videoq-jp/videoq','{id,owner:{id:.owner.id},full_name,default_branch,private}');
 if(repository.id!==1083911938||repository.owner?.id!==349188820||repository.full_name!=='videoq-jp/videoq'||repository.default_branch!=='main'||repository.private!==false)throw Error('CANONICAL_REPOSITORY_VERIFICATION_FAILED');
 const head=read('repos/videoq-jp/videoq/git/ref/heads/main','{object:{sha:.object.sha}}').object?.sha;
 if(!/^[a-f0-9]{40}$/.test(head??''))throw Error('INVALID_CANONICAL_MAIN');
 if(head!==source){const comparison=read(`repos/videoq-jp/videoq/compare/${source}...${head}?per_page=1`,'{status,merge_base_commit:{sha:.merge_base_commit.sha}}');if(comparison.status!=='ahead'||comparison.merge_base_commit?.sha!==source)throw Error('SOURCE_NOT_IN_REVIEWED_MAIN');}
 return{reviewedSource:source,currentMain:head};
}
function createAwsTransport({execute=execFileSync,env=process.env,root=ROOT}={}){
 const allowed={sts:{GetCallerIdentity:'get-caller-identity'},ddb:{GetItem:'get-item',TransactWriteItems:'transact-write-items'},sfn:{DescribeExecution:'describe-execution',DescribeStateMachineForExecution:'describe-state-machine-for-execution',GetExecutionHistory:'get-execution-history'},lambda:{ListEventSourceMappings:'list-event-source-mappings'},codebuild:{BatchGetBuilds:'batch-get-builds'}};
 return async(service,command,input)=>{
  if(!allowed[service]?.[command])throw Error('UNSUPPORTED_ADMISSION_AWS_OPERATION');
  const directory=mkdtempSync(join(tmpdir(),'videoq-admission-metadata-')),file=join(directory,'input.json');
  try{writeFileSync(file,JSON.stringify(input),{mode:0o600});return JSON.parse(run(execute,'aws',[service==='ddb'?'dynamodb':service==='sfn'?'stepfunctions':service,allowed[service][command],'--region','ap-northeast-1','--output','json','--no-cli-pager','--cli-input-json','file://'+file],executionEnv(env,'aws'),root));}
  finally{rmSync(directory,{recursive:true,force:true});}
 };
}
function createGithubTransport({execute=execFileSync,env=process.env,root=ROOT}={}){
 return async(method,path)=>{
  const match=/^repos\/videoq-jp\/videoq\/actions\/workflows\/(252628432|403417588)(?:\/(enable|disable)|\/runs\?status=(queued|in_progress|waiting|pending|requested)&per_page=100&page=([1-9]|10))?$/.exec(path);
  if(!match||method!==(match[2]?'PUT':'GET'))throw Error('UNSUPPORTED_ADMISSION_GITHUB_OPERATION');
  const value=run(execute,'gh',['api','--hostname','github.com','--method',method,path],executionEnv(env,'github'),root);return value.trim()?JSON.parse(value):null;
 };
}
async function main({args=process.argv.slice(2),env=process.env,execute=execFileSync,root=ROOT,fetcher=fetch}={}){
 const operation=parse(args);
 if(env.GITHUB_ACTIONS||env.VIDEOQ_AWS_CLI||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL)throw Error('LOCAL_METADATA_OPERATOR_REQUIRED');
 await verifyReviewedSource({source:operation.source,root,execute,env});
 const identity=JSON.parse(run(execute,'aws',['sts','get-caller-identity','--region','ap-northeast-1','--output','json','--no-cli-pager'],executionEnv(env,'aws'),root));
 if(identity.Account!=='257240362763')throw Error('ADMISSION_AWS_ACCOUNT_MISMATCH');
 const cloudflare=createCloudflareTrafficTransport(env.CLOUDFLARE_API_TOKEN,{fetcher});
 const expectedDefinitionHash=definitionHash(definition({table:TABLE,projects:Object.fromEntries(['rotation','migration','backup','smoke','audit','deploy'].map(k=>[k,'videoq-db-'+k+'-prod']))}));
 const operate=createAdmissionOperator({aws:createAwsTransport({execute,env,root}),github:createGithubTransport({execute,env,root}),cloudflare,table:TABLE,machine:MACHINE,expectedDefinitionHash,enabled:true});
 return operate(operation);
}
module.exports={parse,executionEnv,verifyReviewedSource,createAwsTransport,createGithubTransport,main};
if(require.main===module)main().then(value=>console.log(JSON.stringify(value))).catch(()=>{console.error('ADMISSION_OPERATOR_FAILED: preserve the owned hold and original plans; no automatic restore or unlock was attempted.');process.exitCode=1;});
