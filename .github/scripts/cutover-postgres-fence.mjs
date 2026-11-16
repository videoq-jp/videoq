// Invoked only inside the held AWS activity stage after live admission checks.
// This changes managed LOGIN admission, never business rows or the data-mutation marker.
import {mkdtemp,chmod,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {adminUrl} from './neon-fence-audit.mjs';
const require=createRequire(import.meta.url);
const {acknowledgeReplay}=require('../../infra/db-maintenance/runtime/stage-proof.cjs');
const {assertFenceReleased}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
const hash=s=>createHash('sha256').update(s).digest('hex');
export async function runHeldPostgresFence({env,aws,readParameter,run,root,owned,stopped,original,validateReport}){
 if(!original)throw Error('ORIGINAL_POSTGRES_FENCE_PLAN_REQUIRED');
 const id=env.MAINTENANCE_RUN_ID,action=env.MAINTENANCE_ACTIVITY_ACTION_ID,source=env.MAINTENANCE_SOURCE_SHA,table=env.MAINTENANCE_TABLE;
 let row=await owned(true);
 const operation=row.activity_operation?.S,complete=operation==='install'?'fenced':'released',pending=operation==='install'?'installing':'releasing';
 if(!['install','release'].includes(operation))throw Error('INVALID_POSTGRES_FENCE_OPERATION');
 const originalJson=row.postgres_fence_original_plan.S,originalSha=row.postgres_fence_original_sha256.S;
 if(hash(originalJson)!==originalSha||JSON.stringify(original)!==originalJson)throw Error('ORIGINAL_POSTGRES_FENCE_PLAN_CHANGED');
 function intent(value){
  if(value.postgres_fence_original_plan?.S!==originalJson||value.postgres_fence_original_sha256?.S!==originalSha||value.activity_operation?.S!==operation)throw Error('ORIGINAL_POSTGRES_FENCE_PLAN_CHANGED');
  if(value.postgres_fence_plan_sha256?.S!==originalSha||value.postgres_fence_action_id?.S!==action||![pending,complete].includes(value.postgres_fence_state?.S))throw Error('POSTGRES_FENCE_INTENT_CHANGED');
 }
 function receipt(value){
  intent(value);
  if(value.postgres_fence_state.S!==complete||!/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-rotation-prod:[a-f0-9-]{36}$/.test(value.postgres_fence_build_arn?.S??'')||typeof value.postgres_fence_receipt?.S!=='string'||hash(value.postgres_fence_receipt.S)!==value.postgres_fence_receipt_sha256?.S)throw Error('POSTGRES_FENCE_RECEIPT_REQUIRED');
  if(operation==='release')assertFenceReleased(value);
  else verify(JSON.parse(value.postgres_fence_receipt.S),'fenced');
 }
 function verify(value,state){
  if(value?.state!==state||!Number.isSafeInteger(value.writerLogins)||value.writerLogins<1||value.enabledWriterLogins!==(state==='fenced'?0:value.writerLogins)||value.writerSessions!==0||value.otherDatabaseSessions!==0||value.unknownSessions!==0||value.preparedTransactions!==0)throw Error('POSTGRES_FENCE_CHILD_NOT_VERIFIED');
  return Object.fromEntries(['state','writerLogins','enabledWriterLogins','writerSessions','otherDatabaseSessions','unknownSessions','preparedTransactions'].map(k=>[k,value[k]]));
 }
 async function save(before,fields){
  const values={':execution':before.execution_arn,':source':{S:source},':phase':{S:'activity-auditing'},':revision':before.cutover_revision,':next':{N:String(Number(before.cutover_revision.N)+1)},':action':{S:action},':original':{S:originalSha},':originalPlan':{S:originalJson},':operation':{S:operation},':false':{BOOL:false},':kind':{S:'cutover-hold'}};
  const names={'#phase':'cutover_phase','#revision':'cutover_revision'},sets=['#revision = :next'];
  Object.entries(fields).forEach(([key,value],i)=>{names['#f'+i]=key;values[':v'+i]=value;sets.push('#f'+i+' = :v'+i);});
  // Same owned revision and original baseline must still be authoritative.
  try{await aws('dynamodb','transact-write-items',{TransactItems:[
   {Update:{TableName:table,Key:{pk:{S:'run#'+id}},UpdateExpression:'SET '+sets.join(', '),ConditionExpression:'execution_arn = :execution AND source_sha = :source AND #phase = :phase AND #revision = :revision AND activity_action_id = :action AND postgres_fence_original_sha256 = :original AND postgres_fence_original_plan = :originalPlan AND activity_operation = :operation AND database_mutations_started = :false AND release_requested = :false',ExpressionAttributeNames:names,ExpressionAttributeValues:Object.fromEntries(Object.entries(values).filter(([key])=>key!==':kind'))}},
   {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':before.execution_arn,':kind':values[':kind']}}},
  ]});}catch(error){
   const found=await owned(true);
   if(found.cutover_revision?.N!==values[':next'].N||Object.entries(fields).some(([key,value])=>JSON.stringify(found[key])!==JSON.stringify(value)))throw error;
  }
  const found=await owned(true);
  if(found.cutover_revision?.N!==values[':next'].N||Object.entries(fields).some(([key,value])=>JSON.stringify(found[key])!==JSON.stringify(value)))throw Error('POSTGRES_FENCE_READBACK_FAILED');
  return found;
 }
 if(row.cutover_phase.S==='consumers-paused'){
  if(operation==='install'&&row.activity_operation_outcome?.S==='reconciliation-required'&&!row.postgres_fence_state){
   await acknowledgeReplay({aws:(_s,_c,v)=>aws('dynamodb','transact-write-items',v),get:name=>aws('dynamodb','get-item',{TableName:table,Key:{pk:{S:name}},ConsistentRead:true}),table,row,build:env.CODEBUILD_BUILD_ARN});
   return{fence_install_refused:true,inFlightDrainProven:false};
  }
  receipt(row);
  await acknowledgeReplay({aws:(_s,_c,v)=>aws('dynamodb','transact-write-items',v),get:name=>aws('dynamodb','get-item',{TableName:table,Key:{pk:{S:name}},ConsistentRead:true}),table,row,build:env.CODEBUILD_BUILD_ARN});
  return{[operation==='install'?'fence_installed':'fence_released']:true,inFlightDrainProven:false};
 }
 await stopped();let directory;
 try{
  directory=await mkdtemp(join(tmpdir(),'videoq-held-fence-'));await chmod(directory,0o700);
  const state=join(directory,'original.json');await writeFile(state,originalJson,{mode:0o600});
  const childEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));
  childEnv.VIDEOQ_FENCE_ADMIN_DATABASE_URL=adminUrl((await readParameter('/videoq/security/prod/db-admin')).DATABASE_URL);
  const child=async(mode,mutate=false)=>{
   const args=['--mode',mode,'--state',state];
   const isolated={...childEnv,PGOPTIONS:'-c default_transaction_read_only='+(mutate?'off':'on')+' -c search_path=pg_catalog'};
   if(mutate){args.push('--confirm-database',original.target.databaseName);isolated.VIDEOQ_MIGRATION_UPSTREAM_STOPPED='1';}
   const value=JSON.parse((await run(process.execPath,['--import',pathToFileURL(join(root,'.github/operations-tools/node_modules/tsx/dist/loader.mjs')).href,join(root,'apps/api/scripts/d1-postgres-login-fence.ts'),...args],{cwd:root,env:isolated,timeout:120000,maxBuffer:65536})).stdout.trim());
   if(value.purpose!=='production'||value.upstreamStoppedByThisCommand!==false)throw Error('POSTGRES_FENCE_CHILD_NOT_VERIFIED');return value;
  };
  row=await stopped();
  if(row.postgres_fence_action_id?.S===action&&!(operation==='release'&&row.postgres_fence_state?.S==='installing')){intent(row);}
  else{
   if(operation==='install'){
    assertFenceReleased(row);
    const report=validateReport((await child('activity')).activity);
    if(report.databaseName!==original.target.databaseName)throw Error('POSTGRES_ACTIVITY_DATABASE_MISMATCH');
    if(Object.values(report.counts).some(v=>v!==0)){
     row=await stopped();if(row.postgres_fence_state)throw Error('POSTGRES_FENCE_INTENT_CHANGED');
     const reportJson=JSON.stringify(report);
     await save(row,{cutover_phase:{S:'consumers-paused'},activity_operation_outcome:{S:'reconciliation-required'},activity_report:{S:reportJson},activity_report_sha256:{S:hash(reportJson)},activity_observed:{BOOL:true},cutover_last_build_arn:{S:env.CODEBUILD_BUILD_ARN}});
     return{fence_install_refused:true,inFlightDrainProven:false};
    }
   }else if(!['fenced','installing'].includes(row.postgres_fence_state?.S)||row.postgres_fence_plan_sha256?.S!==originalSha)throw Error('POSTGRES_FENCE_INSTALLATION_REQUIRED');
   row=await stopped();
   row=await save(row,{postgres_fence_state:{S:pending},postgres_fence_plan_sha256:{S:originalSha},postgres_fence_action_id:{S:action},postgres_fence_build_arn:{S:env.CODEBUILD_BUILD_ARN}});
   intent(row);
  }
  // Replays use the immutable original LOGIN plan, including originally retired roles.
  // A failed/unknown child leaves intent and exclusion intact for explicit redrive.
  await stopped();verify(await child(operation,true),operation==='install'?'fenced':'open');
  const observed=verify(await child('inspect'),operation==='install'?'fenced':'open');
  row=await stopped();intent(row);
  const serialized=JSON.stringify(observed);
  row=await save(row,{cutover_phase:{S:'consumers-paused'},postgres_fence_state:{S:complete},postgres_fence_build_arn:{S:env.CODEBUILD_BUILD_ARN},postgres_fence_receipt:{S:serialized},postgres_fence_receipt_sha256:{S:hash(serialized)},cutover_last_build_arn:{S:env.CODEBUILD_BUILD_ARN}});
  receipt(row);
  return{[operation==='install'?'fence_installed':'fence_released']:true,inFlightDrainProven:false};
 }finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
