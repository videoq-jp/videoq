// Fixed AWS read-only stage. DB credentials stay in a stripped child environment.
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {ensureOperatorDependencies,adminUrl} from './neon-fence-audit.mjs';
const require=createRequire(import.meta.url),m=require('./neon-admin.cjs');
const {acknowledgeReplay}=require('../../infra/db-maintenance/runtime/stage-proof.cjs');
const {consumerPlanPrepared}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
const {createConsumerControl,validateConsumerPlan}=require('./cutover-sqs-consumers.cjs');
const {readDeploymentSettings}=require('./protect-api-deployment.cjs');
const {publicApiState}=require('./cutover-consumer-control.cjs');
const {verifyProductionTraffic}=require('./cutover-owned-api-traffic.cjs');
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),execute=promisify(execFile);
const TARGET={purpose:'production',host:'ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech',databaseName:'neondb',rolePrefix:'videoq_'};
const BUILD=/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-rotation-prod:[a-f0-9-]{36}$/;
const hash=s=>createHash('sha256').update(s).digest('hex');
export async function runHeldPostgresActivity({env=process.env,aws=m.aws,readParameter=m.readParameter,run=execute,root=ROOT,fetcher=fetch,ensureDependencies=ensureOperatorDependencies}={}){
 const id=env.MAINTENANCE_RUN_ID,source=env.MAINTENANCE_SOURCE_SHA,action=env.MAINTENANCE_ACTIVITY_ACTION_ID;
 if(env.VIDEOQ_CUTOVER_CONSUMER_CONTROL!=='true'||env.MAINTENANCE_KIND!=='cutover-hold'||env.MAINTENANCE_STAGE!=='cutover-activity-audit'||env.MAINTENANCE_TABLE!=='videoq-db-maintenance-prod'||env.GITHUB_ACTIONS||!/^[a-f0-9]{32}$/.test(id??'')||!/^[a-f0-9]{32}$/.test(action??'')||!/^[a-f0-9]{40}$/.test(source??'')||!BUILD.test(env.CODEBUILD_BUILD_ARN??''))throw Error('AWS_HELD_ACTIVITY_CONTEXT_REQUIRED');
 const table=env.MAINTENANCE_TABLE,arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+id;
 const get=name=>aws('dynamodb','get-item',{TableName:table,Key:{pk:{S:name}},ConsistentRead:true});
 async function owned(allowComplete=false){
  const[r,o]=await Promise.all([get('run#'+id),get('maintenance')]);const row=r.Item;
  if(row?.kind?.S!=='cutover-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==source||row.activity_action_id?.S!==action||row.release_requested?.BOOL!==false||row.database_mutations_started?.BOOL!==false||row.deployment_admission_restored?.BOOL!==false||row.api_admission_restored?.BOOL!==false||row.api_pause_verified?.BOOL!==true||row.consumer_admission_restored?.BOOL!==false||o.Item?.kind?.S!=='cutover-hold'||o.Item.execution_arn?.S!==arn||!consumerPlanPrepared(row)||row.cutover_phase?.S!=='activity-auditing'&&!(allowComplete&&row.cutover_phase?.S==='consumers-paused')||!/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N??'')||!Number.isSafeInteger(Number(row.cutover_revision.N))||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('HELD_ACTIVITY_OWNERSHIP_REQUIRED');return row;
 }
 let row=await owned(true);await ensureDependencies(root);
 const [{postgresLoginFencePlanSchema},{validatePostgresCutoverActivity},{readPrivateInput}]=await Promise.all([
  import(pathToFileURL(join(root,'apps/api/scripts/migrations/d1/postgres-login-fence.ts')).href),import(pathToFileURL(join(root,'apps/api/scripts/migrations/d1/postgres-cutover-activity.ts')).href),import(pathToFileURL(join(root,'apps/api/scripts/migrations/d1/private-input.ts')).href),
 ]);
 const reportOf=value=>{if(typeof value.activity_fence_plan?.S!=='string'||hash(value.activity_fence_plan.S)!==value.activity_fence_plan_sha256?.S||!BUILD.test(value.activity_build_arn?.S??''))throw Error('INVALID_ACTIVITY_FENCE_RECORD');const fence=postgresLoginFencePlanSchema.parse(JSON.parse(value.activity_fence_plan.S));if(JSON.stringify(fence.target)!==JSON.stringify(TARGET))throw Error('INVALID_ACTIVITY_FENCE_RECORD');if(typeof value.activity_report?.S!=='string'||hash(value.activity_report.S)!==value.activity_report_sha256?.S||value.activity_observed?.BOOL!==true)throw Error('INVALID_ACTIVITY_REPORT_RECORD');return validatePostgresCutoverActivity(JSON.parse(value.activity_report.S));};
 if(row.cutover_phase.S==='consumers-paused'){reportOf(row);await acknowledgeReplay({aws:(_s,_c,v)=>aws('dynamodb','transact-write-items',v),get,table,row,build:env.CODEBUILD_BUILD_ARN});return{activity_observed:true,inFlightDrainProven:false,existing_observation_reused:true};}
 const plan=validateConsumerPlan(JSON.parse(row.consumer_plan.S));if(plan.scope.purpose!=='production')throw Error('INVALID_ACTIVITY_CONSUMER_PLAN');const planSha=row.consumer_plan_sha256.S;
 const secret=await readParameter('/videoq/security/prod/cutover-control');
 if(secret.CLOUDFLARE_ACCOUNT_ID!=='12daec56fdba43f677f2766ee26a5a39'||typeof secret.CLOUDFLARE_API_TOKEN!=='string'||secret.CLOUDFLARE_API_TOKEN.length<20||secret.CLOUDFLARE_API_TOKEN.length>4096||/[\r\n\0]/.test(secret.CLOUDFLARE_API_TOKEN))throw Error('INVALID_ACTIVITY_CONTROL_CREDENTIAL');
 const control=createConsumerControl((command,value)=>{if(command!=='ListEventSourceMappings')throw Error('READ_ONLY_ACTIVITY_REQUIRED');return aws('lambda','list-event-source-mappings',value);});
 async function stopped(){
  const current=await owned();if(current.consumer_plan_sha256.S!==planSha||typeof current.consumer_pause_api_state?.S!=='string'||hash(current.consumer_pause_api_state.S)!==current.consumer_pause_api_sha256?.S)throw Error('HELD_ACTIVITY_STOP_RECORD_CHANGED');
  const state=publicApiState(await readDeploymentSettings(secret,fetcher));if(state.traffic!=='paused'||state.serialized!==current.consumer_pause_api_state.S||!(await control.inspect(plan)).admissionPaused)throw Error('HELD_ACTIVITY_ADMISSION_NOT_PAUSED');await verifyProductionTraffic(true,fetcher);return current;
 }
 await stopped();let directory;
 try{
  directory=await mkdtemp(join(tmpdir(),'videoq-held-activity-'));await chmod(directory,0o700);const target=join(directory,'target.json'),state=join(directory,'plan.json');await writeFile(target,JSON.stringify(TARGET),{mode:0o600});
  const childEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));childEnv.VIDEOQ_FENCE_ADMIN_DATABASE_URL=adminUrl((await readParameter('/videoq/security/prod/db-admin')).DATABASE_URL);childEnv.PGOPTIONS='-c default_transaction_read_only=on -c search_path=pg_catalog';
  const child=async args=>run(process.execPath,['--import',pathToFileURL(join(root,'.github/operations-tools/node_modules/tsx/dist/loader.mjs')).href,join(root,'apps/api/scripts/d1-postgres-login-fence.ts'),...args],{cwd:root,env:childEnv,timeout:120000,maxBuffer:65536});
  const proof=JSON.parse((await child(['--mode','prepare','--target',target,'--state',state])).stdout.trim());if(proof.prepared!==true||proof.purpose!=='production'||proof.writeFenceInstalled!==false)throw Error('ACTIVITY_PREPARATION_NOT_VERIFIED');
  const fence=postgresLoginFencePlanSchema.parse(JSON.parse((await readPrivateInput(state,128*1024)).toString()));if(JSON.stringify(fence.target)!==JSON.stringify(TARGET)||fence.roles.length!==proof.roles)throw Error('ACTIVITY_FENCE_TARGET_MISMATCH');
  const result=JSON.parse((await child(['--mode','activity','--state',state])).stdout.trim());if(result.purpose!=='production'||result.upstreamStoppedByThisCommand!==false)throw Error('ACTIVITY_CHILD_NOT_VERIFIED');const report=validatePostgresCutoverActivity(result.activity);if(report.databaseName!==TARGET.databaseName)throw Error('ACTIVITY_DATABASE_MISMATCH');
  row=await stopped();const serialized=JSON.stringify(report),sha=hash(serialized),fenceJson=JSON.stringify(fence);
  if(serialized.length>32768)throw Error('ACTIVITY_REPORT_TOO_LARGE');
  try{await aws('dynamodb','transact-write-items',{TransactItems:[
   {Update:{TableName:table,Key:{pk:{S:'run#'+id}},UpdateExpression:'SET #phase = :paused, #revision = :next, activity_report = :report, activity_report_sha256 = :sha, activity_observed = :true, activity_build_arn = :build, cutover_last_build_arn = :build, activity_fence_plan = :fence, activity_fence_plan_sha256 = :fenceSha',ConditionExpression:'execution_arn = :execution AND source_sha = :source AND #phase = :auditing AND #revision = :previous AND activity_action_id = :action AND activity_observed = :false AND consumer_plan_sha256 = :plan AND database_mutations_started = :false AND release_requested = :false AND deployment_admission_restored = :false AND api_admission_restored = :false AND api_pause_verified = :true AND consumer_admission_restored = :false',ExpressionAttributeNames:{'#phase':'cutover_phase','#revision':'cutover_revision'},ExpressionAttributeValues:{':paused':{S:'consumers-paused'},':next':{N:String(Number(row.cutover_revision.N)+1)},':report':{S:serialized},':sha':{S:sha},':true':{BOOL:true},':build':{S:env.CODEBUILD_BUILD_ARN},':fence':{S:fenceJson},':fenceSha':{S:hash(fenceJson)},':execution':{S:arn},':source':{S:source},':auditing':{S:'activity-auditing'},':previous':row.cutover_revision,':action':{S:action},':false':{BOOL:false},':plan':{S:planSha}}}},
   {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:'cutover-hold'}}}},
  ]});}catch(error){const found=await owned(true);if(found.cutover_phase.S!=='consumers-paused'||found.activity_report?.S!==serialized||found.activity_report_sha256?.S!==sha||found.activity_fence_plan?.S!==fenceJson)throw error;reportOf(found);}
  const found=await owned(true);if(found.cutover_phase.S!=='consumers-paused'||found.activity_report_sha256?.S!==sha)throw Error('ACTIVITY_REPORT_READBACK_FAILED');reportOf(found);return{activity_observed:true,inFlightDrainProven:false};
 }finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await runHeldPostgresActivity()));}catch{console.error('READ_ONLY_HELD_ACTIVITY_FAILED');process.exitCode=1;}}
