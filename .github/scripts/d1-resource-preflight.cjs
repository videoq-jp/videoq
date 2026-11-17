// Read-only platform and reviewed-checkout checks. No SSM, IAM writes, logs,
// database queries, SQL, build starts, credential discovery or fallback.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {executionEnv,verifyReviewedSource}=require('./run-cutover-admission.cjs');
const {resourceDigest,RESOURCE_STEPS}=require('./d1-resource-journal.cjs');
const ROOT=path.resolve(__dirname,'../..'),ACCOUNT='12daec56fdba43f677f2766ee26a5a39',PROJECT='videoq-db-smoke-prod';
const DATABASES=[['e57d0931-18cb-4f00-ae7f-b0068030fb04','videoq-d1-migration-staging-v4'],['587bd210-6d9d-4f32-abb7-a490013e65d3','videoq-prod-db']];
const INDEXES=[['videoq-scenes-migration-v3-1536',1536],['videoq-scenes-migration-v3-768',768],['videoq-prod-scenes-1536',1536],['videoq-prod-scenes-768',768]];
const PATHS=new Set([...DATABASES.map(([id])=>`accounts/${ACCOUNT}/d1/database/${id}`),...INDEXES.map(([name])=>`accounts/${ACCOUNT}/vectorize/v2/indexes/${name}`)]);
const FLAGS={MAINTENANCE_TABLE:'videoq-db-maintenance-prod',VIDEOQ_CUTOVER_CONSUMER_CONTROL:'false',VIDEOQ_CUTOVER_FINAL_HANDOFF:'false',VIDEOQ_CUTOVER_POSTWRITE_RECOVERY:'false',VIDEOQ_D1_PRODUCTION_SMOKE:'true',VIDEOQ_RETAIN_BACKUP:'false',VIDEOQ_EXPORT_D1_FROM_BACKUP:'false'};
function createResourcePreflightAws({execute=execFileSync,env=process.env,root=ROOT}={}){
 return async(service,command,input)=>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('RESOURCE_PREFLIGHT_AWS_OPERATION_REFUSED');
  const action=service==='sts'&&command==='GetCallerIdentity'&&Object.keys(input??{}).length===0?'get-caller-identity':service==='codebuild'&&command==='BatchGetProjects'&&resourceDigest(input)===resourceDigest({names:[PROJECT]})?'batch-get-projects':null;
  if(!action)throw Error('RESOURCE_PREFLIGHT_AWS_OPERATION_REFUSED');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'videoq-resource-preflight-')),file=path.join(directory,'input.json');
  try{
   fs.writeFileSync(file,JSON.stringify(input),{mode:0o600});
   return JSON.parse(execute('aws',[service,action,'--region','ap-northeast-1','--output','json','--no-cli-pager','--no-paginate','--cli-input-json','file://'+file],{cwd:root,env:executionEnv(env,'aws'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:4*1024*1024}));
  }catch{throw Error('RESOURCE_PREFLIGHT_AWS_READ_FAILED');}
  finally{fs.rmSync(directory,{recursive:true,force:true});}
 };
}
function createResourceMetadataTransport(token,{fetcher=fetch}={}){
 if(typeof token!=='string'||token.length<20||token.length>4096||/[\r\n\0]/.test(token)||typeof fetcher!=='function')throw Error('RESOURCE_PREFLIGHT_TOKEN_REQUIRED');
 return async(method,url)=>{
  if(method!=='GET'||!PATHS.has(url))throw Error('RESOURCE_PREFLIGHT_CF_OPERATION_REFUSED');
  try{
   const response=await fetcher('https://api.cloudflare.com/client/v4/'+url,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});
   if(!response.ok){await response.body?.cancel();throw Error('refused');}
   const reader=response.body.getReader(),chunks=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw Error('limit');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
   const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(value?.success!==true||value.errors!==undefined&&(!Array.isArray(value.errors)||value.errors.length)||!value.result||typeof value.result!=='object'||Array.isArray(value.result))throw Error('shape');
   return value.result;
  }catch{throw Error('RESOURCE_PREFLIGHT_CF_READ_FAILED');}
 };
}
function smokeProject(row){
 const reviewed=row?.tags?.filter(v=>v.key==='ReviewedSource'),variables=row?.environment?.environmentVariables;
 if(row?.name!==PROJECT||row.arn!==`arn:aws:codebuild:ap-northeast-1:257240362763:project/${PROJECT}`||row.serviceRole!==`arn:aws:iam::257240362763:role/${PROJECT}`||row.source?.type!=='S3'||row.source.location!=='videoq-db-maintenance-prod-257240362763/operator.zip'||typeof row.source.buildspec!=='string'||!row.source.buildspec||typeof row.sourceVersion!=='string'||!row.sourceVersion||row.sourceVersion.length>1024||row.concurrentBuildLimit!==1||reviewed?.length!==1||!/^[a-f0-9]{40}$/.test(reviewed[0].value??''))throw Error('RESOURCE_PREFLIGHT_REVIEWED_PROJECT_REQUIRED');
 const runtime=row.environment;
 if(runtime.type!=='LINUX_CONTAINER'||runtime.image!=='aws/codebuild/standard:7.0'||runtime.computeType!=='BUILD_GENERAL1_SMALL'||runtime.privilegedMode!==false||runtime.imagePullCredentialsType!=='CODEBUILD'||runtime.registryCredential||!Array.isArray(variables)||variables.length!==Object.keys(FLAGS).length||new Set(variables.map(v=>v.name)).size!==variables.length||variables.some(v=>v.type!=='PLAINTEXT'||FLAGS[v.name]!==v.value))throw Error('RESOURCE_PREFLIGHT_D1_PROJECT_REQUIRED');
 const {environmentVariables,...configuration}=runtime;
 return{reviewedSource:reviewed[0].value,sourceVersion:row.sourceVersion,projectSha256:resourceDigest({source:row.source,sourceVersion:row.sourceVersion,serviceRole:row.serviceRole,runtime:configuration,variables:Object.fromEntries(variables.map(v=>[v.name,v.value]))})};
}
async function readResourcePlatform({aws,cloudflare}){
 if(typeof aws!=='function'||typeof cloudflare!=='function')throw Error('RESOURCE_PREFLIGHT_TRANSPORT_REQUIRED');
 const identity=await aws('sts','GetCallerIdentity',{});if(identity.Account!=='257240362763')throw Error('RESOURCE_PREFLIGHT_AWS_ACCOUNT_MISMATCH');
 const [projects,...resources]=await Promise.all([aws('codebuild','BatchGetProjects',{names:[PROJECT]}),...[...PATHS].map(url=>cloudflare('GET',url))]);
 if(projects.projectsNotFound?.length||projects.projects?.length!==1)throw Error('RESOURCE_PREFLIGHT_PROJECT_REQUIRED');
 const project=smokeProject(projects.projects[0]);
 const databases=DATABASES.map(([uuid,name],i)=>{const row=resources[i];if(row?.uuid!==uuid||row.name!==name||row.read_replication?.mode!=='disabled')throw Error('RESOURCE_PREFLIGHT_D1_CONFIG_REQUIRED');return{uuid,name,readReplication:'disabled'};});
 const indexes=INDEXES.map(([name,dimensions],i)=>{const row=resources[DATABASES.length+i];if(row?.name!==name||row.config?.dimensions!==dimensions||row.config.metric!=='cosine')throw Error('RESOURCE_PREFLIGHT_VECTOR_CONFIG_REQUIRED');return{name,dimensions,metric:'cosine'};});
 const platform={accountId:ACCOUNT,databases,indexes};return{...platform,...project,platformSha256:resourceDigest(platform)};
}
function createResourcePreflight({source,expectedProjectSha256,aws,cloudflare,execute=execFileSync,env=process.env,root=ROOT}){
 if(!/^[a-f0-9]{40}$/.test(source??'')||!/^[a-f0-9]{64}$/.test(expectedProjectSha256??'')||typeof aws!=='function'||typeof cloudflare!=='function'||fs.realpathSync(root)!==fs.realpathSync(ROOT))throw Error('RESOURCE_PREFLIGHT_CONTEXT_REQUIRED');
 return async({mode,step,stage})=>{
  if(!['normal','abort'].includes(mode)||![...RESOURCE_STEPS,'claim','completion','recovery'].includes(step)||typeof stage!=='string'||!stage||env.GITHUB_ACTIONS||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL)throw Error('RESOURCE_PREFLIGHT_LOCAL_CONTEXT_REQUIRED');
  // The existing verifier proves this clean checkout is the exact held source,
  // in canonical-main history. Recovery remains possible after main advances.
  const reviewed=await verifyReviewedSource({source,root,execute,env});
  const actual=await readResourcePlatform({aws,cloudflare});
  if(actual.reviewedSource!==source||actual.projectSha256!==expectedProjectSha256)throw Error('RESOURCE_PREFLIGHT_SOURCE_OR_PROJECT_DRIFT');
  return{reviewedSource:source,currentMain:reviewed.currentMain,projectSha256:actual.projectSha256,platformSha256:actual.platformSha256};
 };
}
module.exports={createResourcePreflightAws,createResourceMetadataTransport,readResourcePlatform,createResourcePreflight};
