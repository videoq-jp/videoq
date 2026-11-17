// Scoped operator AWS transport. No arbitrary row, job override, log, secret,
// IAM, SQL, function-code or hold-release operation is exposed.
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {executionEnv}=require('./run-cutover-admission.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
const {validateConsumerPlan}=require('./cutover-sqs-consumers.cjs');
const TABLE='videoq-db-maintenance-prod',SMOKE='videoq-db-smoke-prod';
const PROJECTS=['videoq-db-migration-prod',SMOKE,'videoq-db-deploy-prod'],FUNCTIONS=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'];
const BUILD=/^(?:arn:aws:codebuild:ap-northeast-1:257240362763:build\/)?(videoq-db-(?:migration|smoke|deploy)-prod):[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/,compact=value=>typeof value==='string'?value.replace(/\s/g,''):'';
const U={steps:'SET resource_steps=:steps,resource_steps_sha256=:sha,resource_revision=:next',claim:'SET resource_executor_sha256=:executor,resource_revision=:next',abort:'SET resource_abort_requested=:true,resource_revision=:next',smoke:'SET resource_revision=:next,resource_smoke_action_id=:action,resource_smoke_plan_sha256=:plan,resource_smoke_source_version=:version,resource_smoke_state=:starting',complete:'SET resource_phase=:verified,release_requested=:true,resource_revision=:next,api_admission_restored=:true,consumer_admission_restored=:true,deployment_admission_restored=:true,resource_completion_receipt=:receipt,resource_completion_receipt_sha256=:receiptSha',abortComplete:'SET resource_phase=:aborted,release_requested=:true,resource_revision=:next,api_admission_restored=:true,consumer_admission_restored=:true,deployment_admission_restored=:true,resource_completion_receipt=:receipt,resource_completion_receipt_sha256=:receiptSha,resource_steps=:steps,resource_steps_sha256=:stepsSha'};
const own='execution_arn=:execution AND #kind=:kind AND source_sha=:source';
const live=' AND resource_executor_sha256=:executor AND resource_phase=:holding AND release_requested=:false AND resource_revision=:previous';
const CONDITIONS={
 claim:[own+' AND resource_phase=:holding AND release_requested=:false AND resource_revision=:previous AND attribute_not_exists(resource_executor_sha256) AND attribute_not_exists(resource_steps)'],
 steps:[...['resource_steps=:oldSteps AND resource_steps_sha256=:oldSha','attribute_not_exists(resource_steps) AND attribute_not_exists(resource_steps_sha256)']].map(old=>own+' AND resource_phase=:holding AND release_requested=:false AND resource_revision=:previous AND resource_executor_sha256=:executor AND '+old),
 abort:[own+' AND resource_phase=:holding AND release_requested=:false AND resource_executor_sha256=:executor AND resource_revision=:previous AND attribute_not_exists(resource_abort_requested)'],
 smoke:[own+live+' AND attribute_not_exists(resource_smoke_action_id)'],
 registered:[own+live+' AND resource_smoke_action_id=:action AND resource_smoke_plan_sha256=:plan AND resource_smoke_source_version=:version AND resource_smoke_state=:starting AND attribute_not_exists(resource_smoke_build_arn)'],
 complete:['execution_arn=:execution AND source_sha=:source AND #kind=:kind AND resource_executor_sha256=:executor AND resource_phase=:holding AND release_requested=:false AND resource_revision=:previous AND resource_steps=:steps AND resource_steps_sha256=:stepsSha AND attribute_not_exists(resource_completion_receipt)'],
 abortComplete:[own+' AND resource_executor_sha256=:executor AND resource_abort_requested=:true AND resource_phase=:holding AND release_requested=:false AND resource_revision=:previous AND attribute_not_exists(resource_completion_receipt)'],
};
const allowedValues=new Set([':execution',':kind',':source',':executor',':holding',':false',':true',':previous',':next',':steps',':sha',':oldSteps',':oldSha',':action',':plan',':version',':starting',':build',':verified',':aborted',':stepsSha',':receipt',':receiptSha']);
const same=(a,b)=>{try{return resourceDigest(a)===resourceDigest(b);}catch{return false;}},keys=(value,wanted)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...wanted].sort().join(',');
function createResourceAwsTransport({run,source,executorSha256,definitionSha256,plans,mutationsEnabled=false,execute=promisify(execFile),env=process.env,root=path.resolve(__dirname,'../..')}){
 if(!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||typeof mutationsEnabled!=='boolean'||mutationsEnabled&&(!HEX.test(executorSha256??'')||!HEX.test(definitionSha256??'')||typeof plans?.load!=='function'))throw Error('RESOURCE_AWS_CONTEXT_REQUIRED');
 const execution='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
 const refused=()=>{throw Error('RESOURCE_AWS_OPERATION_REFUSED');};
 async function native(){const plan=await plans.load('verify-e2e');if(!plan||plan.nativePlan?.version!==1||plan.nativePlan.run!==run||plan.nativePlan.source!==source||!HEX.test(plan.nativePlan.projectSha256??'')||!/^[a-f0-9]{32}$/.test(plan.nativePlan?.actionId??'')||typeof plan.nativePlan.sourceVersion!=='string'||!plan.nativePlan.sourceVersion||plan.nativePlan.sourceVersion.length>1024)refused();return plan;}
 async function transaction(input){
  if(!keys(input,['TransactItems'])||!Array.isArray(input.TransactItems)||input.TransactItems.length!==2)refused();const [first,second]=input.TransactItems;
  if(!keys(first,['Update'])||!keys(second,['ConditionCheck']))refused();const update=first.Update,check=second.ConditionCheck;
  if(!keys(update,['TableName','Key','UpdateExpression','ConditionExpression','ExpressionAttributeNames','ExpressionAttributeValues'])||update.TableName!==TABLE||!same(update.Key,{pk:{S:'run#'+run}})||!same(update.ExpressionAttributeNames,{'#kind':'kind'}))refused();
  if(!keys(check,['TableName','Key','ConditionExpression','ExpressionAttributeNames','ExpressionAttributeValues'])||check.TableName!==TABLE||!same(check.Key,{pk:{S:'maintenance'}})||compact(check.ConditionExpression)!==compact('execution_arn=:execution AND #kind=:kind')||!same(check.ExpressionAttributeNames,{'#kind':'kind'})||!same(check.ExpressionAttributeValues,{':execution':{S:execution},':kind':{S:'d1-resource-hold'}}))refused();
  const expression=compact(update.UpdateExpression),type=Object.entries(U).find(([,value])=>compact(value)===expression)?.[0]??(expression===compact(U.smoke+',resource_smoke_build_arn=:build')?'registered':null),v=update.ExpressionAttributeValues;
  if(!type||!CONDITIONS[type].some(value=>compact(value)===compact(update.ConditionExpression))||!v||Object.keys(v).some(k=>!allowedValues.has(k))||!same(v[':execution'],{S:execution})||!same(v[':kind'],{S:'d1-resource-hold'})||!same(v[':source'],{S:source})||!same(v[':executor'],{S:executorSha256}))refused();
  for(const [name,value] of Object.entries({':holding':{S:'holding'},':false':{BOOL:false},':true':{BOOL:true},':verified':{S:'verified'},':aborted':{S:'aborted'},':starting':{S:'starting'}}))if(v[name]&&!same(v[name],value))refused();
  if(!/^(0|[1-9][0-9]*)$/.test(v[':previous']?.N??'')||!Number.isSafeInteger(Number(v[':previous'].N))||Number(v[':previous'].N)>=Number.MAX_SAFE_INTEGER||v[':next']?.N!==String(Number(v[':previous'].N)+1))refused();
  for(const [text,hash] of [[':steps',type==='steps'?':sha':':stepsSha'],[':oldSteps',':oldSha'],[':receipt',':receiptSha']])if(v[text]){if(typeof v[text].S!=='string'||v[text].S.length>32768)refused();let value;try{value=JSON.parse(v[text].S);}catch{refused();}if(v[hash]?.S!==resourceDigest(value))refused();}
  if(type==='smoke'||type==='registered'){const plan=await native();if(v[':action']?.S!==plan.nativePlan.actionId||v[':plan']?.S!==resourceDigest(plan)||v[':version']?.S!==plan.nativePlan.sourceVersion||type==='registered'&&(!BUILD.test(v[':build']?.S??'')||!v[':build'].S.startsWith('arn:aws:codebuild:ap-northeast-1:257240362763:build/'+SMOKE+':')))refused();}
 }
 return async(service,command,input)=>{
  if(!input||typeof input!=='object'||Array.isArray(input))refused();let action;
  if(service==='sts'&&command==='GetCallerIdentity'&&keys(input,[]))action='get-caller-identity';
  if(service==='ddb'&&command==='GetItem'&&keys(input,['TableName','Key','ConsistentRead'])&&input.TableName===TABLE&&input.ConsistentRead===true&&[run?'run#'+run:null,'maintenance'].some(pk=>same(input.Key,{pk:{S:pk}})))action='get-item';
  if(service==='sfn'&&['DescribeExecution','DescribeStateMachineForExecution'].includes(command)&&same(input,{executionArn:execution}))action=command==='DescribeExecution'?'describe-execution':'describe-state-machine-for-execution';
  if(service==='codebuild'&&command==='BatchGetProjects'&&same(input,{names:[SMOKE]}))action='batch-get-projects';
  if(service==='codebuild'&&command==='ListBuildsForProject'&&keys(input,input.nextToken===undefined?['projectName']:['projectName','nextToken'])&&PROJECTS.includes(input.projectName)&&(input.nextToken===undefined||typeof input.nextToken==='string'&&input.nextToken.length>0&&input.nextToken.length<=4096))action='list-builds-for-project';
  if(service==='codebuild'&&command==='BatchGetBuilds'&&keys(input,['ids'])&&Array.isArray(input.ids)&&input.ids.length>0&&input.ids.length<=100&&new Set(input.ids).size===input.ids.length&&input.ids.every(id=>typeof id==='string'&&BUILD.test(id)))action='batch-get-builds';
  if(service==='lambda'&&command==='ListEventSourceMappings'&&keys(input,['FunctionName','MaxItems'])&&FUNCTIONS.includes(input.FunctionName)&&input.MaxItems===100)action='list-event-source-mappings';
  const mutation=service==='ddb'&&command==='TransactWriteItems'||service==='codebuild'&&command==='StartBuild'||service==='lambda'&&command==='UpdateEventSourceMapping';
  if(mutation){
   if(!mutationsEnabled)throw Error('RESOURCE_AWS_MUTATIONS_DISABLED');
   if(service==='ddb'){await transaction(input);action='transact-write-items';}
   else if(service==='lambda'){
    const plan=validateConsumerPlan(await plans.load('pause-consumers')),row=plan.consumers.find(v=>v.mappingUuid===input.UUID);
    if(plan.scope.purpose!=='production'||!keys(input,['UUID','Enabled'])||typeof input.Enabled!=='boolean'||!row||input.Enabled&&!row.wasEnabled)refused();action='update-event-source-mapping';
   }else{
    const plan=await native(),variables={MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_STAGE:'smoke',MAINTENANCE_KIND:'smoke',VERIFY_AI_ANSWERS:'true',VIDEOQ_D1_RESOURCE_SMOKE:'true',VIDEOQ_D1_RESOURCE_ACTION_ID:plan.nativePlan.actionId,VIDEOQ_D1_RESOURCE_PLAN_SHA256:resourceDigest(plan),VIDEOQ_D1_RESOURCE_EXECUTOR_SHA256:executorSha256,VIDEOQ_D1_RESOURCE_DEFINITION_SHA256:definitionSha256};
    const rows=input.environmentVariablesOverride;
    if(!keys(input,['projectName','sourceVersion','idempotencyToken','environmentVariablesOverride'])||input.projectName!==SMOKE||input.sourceVersion!==plan.nativePlan.sourceVersion||input.idempotencyToken!==plan.nativePlan.actionId||!Array.isArray(rows)||rows.length!==10||new Set(rows.map(v=>v.name)).size!==10||rows.some(v=>!keys(v,['name','value','type'])||v.type!=='PLAINTEXT'||variables[v.name]!==v.value))refused();action='start-build';
   }
  }
  if(!action)refused();const text=JSON.stringify(input);if(Buffer.byteLength(text)>128*1024)refused();const directory=await fs.mkdtemp(path.join(os.tmpdir(),'videoq-resource-aws-')),file=path.join(directory,'input.json');
  try{await fs.writeFile(file,text,{mode:0o600});const result=await execute('aws',[service==='ddb'?'dynamodb':service==='sfn'?'stepfunctions':service,action,'--region','ap-northeast-1','--output','json','--no-cli-pager','--no-paginate','--cli-input-json','file://'+file],{cwd:root,env:executionEnv(env,'aws'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:8*1024*1024});return JSON.parse(result.stdout);}
  catch{throw Error('RESOURCE_AWS_REQUEST_FAILED');}finally{await fs.rm(directory,{recursive:true,force:true});}
 };
}
module.exports={createResourceAwsTransport};
