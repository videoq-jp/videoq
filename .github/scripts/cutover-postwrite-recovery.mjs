// Fixed root-operated AWS recovery stage. No ordinary broker operation can
// start it. The trusted operator must first persist its immutable recovery input
// reference under the still-owned post-write hold. This stage never reopens it.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,writeFile,readFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {z} from 'zod';
import {ensureOperatorDependencies,adminUrl} from './neon-fence-audit.mjs';
const require=createRequire(import.meta.url),m=require('./neon-admin.cjs');
const {runRecoveryChild}=require('./cutover-recovery-child.cjs');
const {readDeploymentSettings}=require('./protect-api-deployment.cjs');
const {publicApiState}=require('./cutover-consumer-control.cjs');
const {verifyProductionTraffic}=require('./cutover-owned-api-traffic.cjs');
const {createConsumerControl,validateConsumerPlan}=require('./cutover-sqs-consumers.cjs');
const {createDeploymentFreeze,validateDeploymentFreezePlan}=require('./cutover-deployment-freeze.cjs');
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),execute=promisify(execFile);
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39',BUCKET='videoq-db-archives-prod-257240362763';
const BUILD=/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-rotation-prod:[a-f0-9-]{36}$/;
const digest=s=>createHash('sha256').update(s).digest('hex'),hex=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[a-f0-9]{32}$/);
const reference=z.object({version:z.literal(1),runId:id,sourceSha:z.string().regex(/^[a-f0-9]{40}$/),actionId:id,key:z.string(),versionId:z.string().min(1).max(1024).refine(v=>v!=='null'&&!/[\x00-\x20\x7f]/.test(v)),bytes:z.number().int().min(1).max(128*1024*1024),sha256Base64:z.string().regex(/^[A-Za-z0-9+/]{43}=$/),manifestSha256:hex,originalPlanSha256:hex,databaseId:z.uuid(),databaseName:z.string().regex(/^videoq-[a-z0-9-]{1,80}$/)}).strict();
const fenceState=z.object({target:z.object({version:z.literal(1),accountId:z.literal(ACCOUNT),databaseId:z.uuid(),databaseName:z.string(),purpose:z.literal('production')}).strict(),manifestSha256:hex,plan:z.object({version:z.literal(1),databaseId:z.uuid(),operationId:id,tables:z.array(z.string()).min(1).max(200),schemaSha256:hex}).strict()}).strict();
const childReceipt=z.object({version:z.literal(1),runId:id,sourceSha:z.string().regex(/^[a-f0-9]{40}$/),actionId:id,inputSha256:z.string().regex(/^[A-Za-z0-9+/]{43}=$/),snapshotSha256:hex,manifestSha256:hex,postgresLoginFenceVerified:z.literal(true),restoredSha256:hex,visualRecovery:z.object({objects:z.number().int().nonnegative().safe(),bytes:z.number().int().nonnegative().safe(),sha256:hex}).strict(),productionSafe:z.literal(false)}).strict();
export async function runHeldPostwriteRecovery({env=process.env,aws=m.aws,readParameter=m.readParameter,run=execute,child=runRecoveryChild,root=ROOT,fetcher=fetch,ensureDependencies=ensureOperatorDependencies}={}){
 const runId=env.MAINTENANCE_RUN_ID,source=env.MAINTENANCE_SOURCE_SHA,action=env.MAINTENANCE_RECOVERY_ACTION_ID,table=env.MAINTENANCE_TABLE;
 if(env.VIDEOQ_CUTOVER_POSTWRITE_RECOVERY!=='true'||env.MAINTENANCE_KIND!=='cutover-hold'||env.MAINTENANCE_STAGE!=='cutover-postwrite-recovery'||table!=='videoq-db-maintenance-prod'||env.GITHUB_ACTIONS||!id.safeParse(runId).success||!id.safeParse(action).success||!/^[a-f0-9]{40}$/.test(source??'')||!BUILD.test(env.CODEBUILD_BUILD_ARN??''))throw Error('FIXED_AWS_HELD_RECOVERY_REQUIRED');
 const arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+runId;
 const get=name=>aws('dynamodb','get-item',{TableName:table,Key:{pk:{S:name}},ConsistentRead:true});
 let pinned;
 async function owned(){
  const [r,o]=await Promise.all([get('run#'+runId),get('maintenance')]);const row=r.Item;
  if(row?.kind?.S!=='cutover-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==source||row.recovery_action_id?.S!==action||row.release_requested?.BOOL!==false||row.database_mutations_started?.BOOL!==true||row.cutover_phase?.S!=='consumers-paused'||row.postgres_fence_state?.S!=='fenced'||row.api_pause_verified?.BOOL!==true||['api_admission_restored','deployment_admission_restored','consumer_admission_restored'].some(k=>row[k]?.BOOL!==false)||o.Item?.kind?.S!=='cutover-hold'||o.Item.execution_arn?.S!==arn||!['requested','prepared','restored'].includes(row.recovery_state?.S)||!/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N??'')||!Number.isSafeInteger(Number(row.cutover_revision.N))||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('POSTWRITE_RECOVERY_OWNERSHIP_REQUIRED');
  const text=row.recovery_input_ref?.S;if(typeof text!=='string'||digest(text)!==row.recovery_input_ref_sha256?.S)throw Error('RECOVERY_INPUT_REFERENCE_REQUIRED');
  const ref=reference.parse(JSON.parse(text));if(ref.runId!==runId||ref.sourceSha!==source||ref.actionId!==action||ref.key!=='cutover-recovery/'+runId+'/'+action+'.json'||pinned&&text!==pinned)throw Error('RECOVERY_INPUT_REFERENCE_CHANGED');pinned=text;
  if(digest(row.postgres_fence_original_plan?.S??'')!==ref.originalPlanSha256||row.postgres_fence_original_sha256?.S!==ref.originalPlanSha256||row.postgres_fence_plan_sha256?.S!==ref.originalPlanSha256)throw Error('ORIGINAL_POSTGRES_PLAN_CHANGED');
  for(const [field,sha] of [['consumer_plan','consumer_plan_sha256'],['deployment_freeze_plan','deployment_freeze_sha256']])if(typeof row[field]?.S!=='string'||digest(row[field].S)!==row[sha]?.S)throw Error('RECOVERY_ADMISSION_PLAN_CHANGED');
  return{row,ref};
 }
 let {row,ref}=await owned();await ensureDependencies(root);
 const [{readPrivateInput},{inspectD1WriteFence},{recoveryHash},{loadMigrationSnapshot},{buildMigrationManifest}]=await Promise.all([
  import(pathToFileURL(join(root,'apps/api/scripts/migrations/d1/private-input.ts')).href),import(pathToFileURL(join(root,'apps/api/scripts/migrations/d1/write-fence.ts')).href),import(pathToFileURL(join(root,'apps/api/scripts/migrations/d1/postwrite-recovery.ts')).href),import(pathToFileURL(join(root,'apps/api/scripts/d1-migration-manifest.ts')).href),import(pathToFileURL(join(root,'apps/api/scripts/migrations/d1/manifest.ts')).href),
 ]);
 const manifest=buildMigrationManifest(await loadMigrationSnapshot(join(root,'apps/api/drizzle')),await loadMigrationSnapshot(join(root,'apps/api/drizzle-d1')));
 if(!manifest.mapping_complete||recoveryHash(manifest)!==ref.manifestSha256)throw Error('RECOVERY_MAPPING_CHANGED');
 const cf=await readParameter('/videoq/security/prod/d1-migration');
 if(cf.CLOUDFLARE_ACCOUNT_ID!==ACCOUNT||typeof cf.CLOUDFLARE_API_TOKEN!=='string'||cf.CLOUDFLARE_API_TOKEN.length<20||cf.CLOUDFLARE_API_TOKEN.length>4096||/[\r\n\0]/.test(cf.CLOUDFLARE_API_TOKEN))throw Error('INVALID_RECOVERY_D1_CREDENTIAL');
 const consumerPlan=validateConsumerPlan(JSON.parse(row.consumer_plan.S)),deploymentPlan=validateDeploymentFreezePlan(JSON.parse(row.deployment_freeze_plan.S));
 if(consumerPlan.scope.purpose!=='production')throw Error('PRODUCTION_RECOVERY_PLAN_REQUIRED');
 const consumers=createConsumerControl((command,value)=>{if(command!=='ListEventSourceMappings')throw Error('READ_ONLY_RECOVERY_REQUIRED');return aws('lambda','list-event-source-mappings',value);});
 async function deploymentRequest(method,path){
  path=path.replace(/^\//,'');if(method!=='GET'||!path.startsWith('repos/videoq-jp/videoq/actions/workflows/'))throw Error('READ_ONLY_DEPLOYMENT_CHECK_REQUIRED');
  const response=await fetcher('https://api.github.com/'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{accept:'application/vnd.github+json'}});
  if(!response.ok)throw Error('DEPLOYMENT_FREEZE_UNVERIFIED');return response.json();
 }
 const frozen=await createDeploymentFreeze(deploymentRequest).inspect(deploymentPlan);
 if(!frozen.admissionFrozen||!frozen.githubRunsDrained)throw Error('DEPLOYMENT_FREEZE_UNVERIFIED');
 async function stopped(){
  const current=await owned();
  if(current.row.consumer_plan.S!==row.consumer_plan.S||current.row.deployment_freeze_plan.S!==row.deployment_freeze_plan.S)throw Error('RECOVERY_ADMISSION_PLAN_CHANGED');
  for(const workflow of deploymentPlan.workflows){const status=await deploymentRequest('GET','/repos/videoq-jp/videoq/actions/workflows/'+workflow.id);if(status.id!==workflow.id||status.path!==workflow.path||status.state!=='disabled_manually')throw Error('DEPLOYMENT_FREEZE_UNVERIFIED');}
  const settings=await readDeploymentSettings(cf,fetcher),state=publicApiState(settings),database=settings.bindings.filter(b=>b.name==='DB');
  if(state.traffic!=='paused'||database.length!==1||database[0].type!=='d1'||database[0].id!==ref.databaseId||!(await consumers.inspect(consumerPlan)).admissionPaused)throw Error('RECOVERY_WRITERS_NOT_STOPPED');
  await verifyProductionTraffic(true,fetcher);return current;
 }
 async function d1query(sql){
  const response=await fetcher('https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+ref.databaseId+'/query',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+cf.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},body:JSON.stringify({sql,params:[]})});
  if(!response.ok||!response.body)throw Error('RECOVERY_D1_READ_FAILED');let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.byteLength;if(size>128*1024*1024)throw Error('RECOVERY_D1_READ_FAILED');chunks.push(Buffer.from(chunk));}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(body?.success!==true||body.result?.length!==1||body.result[0].success!==true||!Array.isArray(body.result[0].results))throw Error('RECOVERY_D1_READ_FAILED');return body.result[0];
 }
 async function save(before,fields){
  const names={'#revision':'cutover_revision'},values={':execution':{S:arn},':source':{S:source},':action':{S:action},':input':{S:pinned},':previous':before.cutover_revision,':next':{N:String(Number(before.cutover_revision.N)+1)},':true':{BOOL:true},':false':{BOOL:false},':phase':{S:'consumers-paused'},':fenced':{S:'fenced'}},sets=['#revision=:next'];
  Object.entries(fields).forEach(([key,value],i)=>{names['#f'+i]=key;values[':f'+i]=value;sets.push('#f'+i+'=:f'+i);});
  try{await aws('dynamodb','transact-write-items',{TransactItems:[
   {Update:{TableName:table,Key:{pk:{S:'run#'+runId}},UpdateExpression:'SET '+sets.join(', '),ConditionExpression:'execution_arn=:execution AND source_sha=:source AND recovery_action_id=:action AND recovery_input_ref=:input AND #revision=:previous AND database_mutations_started=:true AND release_requested=:false AND cutover_phase=:phase AND postgres_fence_state=:fenced AND api_pause_verified=:true AND api_admission_restored=:false AND deployment_admission_restored=:false AND consumer_admission_restored=:false',ExpressionAttributeNames:names,ExpressionAttributeValues:values}},
   {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn=:execution AND #kind=:kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:'cutover-hold'}}}},
  ]});}catch(error){const found=(await owned()).row;if(found.cutover_revision.N!==values[':next'].N||Object.entries(fields).some(([key,value])=>JSON.stringify(found[key])!==JSON.stringify(value)))throw error;}
  const found=(await owned()).row;if(found.cutover_revision.N!==values[':next'].N||Object.entries(fields).some(([key,value])=>JSON.stringify(found[key])!==JSON.stringify(value)))throw Error('RECOVERY_INTENT_READBACK_FAILED');return found;
 }
 let directory;
 try{
  await stopped();directory=await mkdtemp(join(tmpdir(),'videoq-production-recovery-'));await chmod(directory,0o700);
  const input=join(directory,'input.json'),state=join(directory,'original.json'),receipt=join(directory,'receipt.json');const file=await open(input,'wx',0o600);await file.close();
  const awsEnv=Object.fromEntries(Object.entries(env).filter(([key])=>key.startsWith('AWS_')||['PATH','HOME','TMPDIR','LANG'].includes(key)));Object.assign(awsEnv,{AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true',AWS_PAGER:''});
  const fetched=JSON.parse((await run('aws',['s3api','get-object','--bucket',BUCKET,'--key',ref.key,'--version-id='+ref.versionId,'--checksum-mode','ENABLED','--expected-bucket-owner','257240362763','--region','ap-northeast-1','--output','json','--no-cli-pager',input],{env:awsEnv,timeout:120000,maxBuffer:65536})).stdout);
  const bytes=await readPrivateInput(input,128*1024*1024);
  if(fetched.VersionId!==ref.versionId||fetched.DeleteMarker||fetched.ServerSideEncryption!=='AES256'||fetched.ContentLength!==ref.bytes||bytes.length!==ref.bytes||fetched.ChecksumSHA256!==ref.sha256Base64||createHash('sha256').update(bytes).digest('base64')!==ref.sha256Base64)throw Error('PRIVATE_RECOVERY_INPUT_CHANGED');
  const snapshot=JSON.parse(bytes.toString());if(snapshot.version!==1||snapshot.runId!==runId||snapshot.sourceSha!==source||snapshot.actionId!==action||snapshot.manifestSha256!==ref.manifestSha256)throw Error('RECOVERY_SNAPSHOT_OWNERSHIP_CHANGED');
  const fence=fenceState.parse(snapshot.d1Fence);
  if(fence.target.databaseId!==ref.databaseId||fence.target.databaseName!==ref.databaseName||fence.plan.databaseId!==ref.databaseId||fence.manifestSha256!==digest(JSON.stringify(manifest))||JSON.stringify([...fence.plan.tables].sort())!==JSON.stringify([...manifest.target_insert_order,'d1_migrations'].sort()))throw Error('RECOVERY_D1_FENCE_CHANGED');
  const metadataResponse=await fetcher('https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+ref.databaseId,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+cf.CLOUDFLARE_API_TOKEN}}),metadata=await metadataResponse.json();
  if(!metadataResponse.ok||metadata?.success!==true||metadata.result?.uuid!==ref.databaseId||metadata.result?.name!==ref.databaseName)throw Error('RECOVERY_D1_TARGET_CHANGED');
  const connection={databaseId:ref.databaseId,database:{prepare:sql=>({all:()=>d1query(sql)})}};
  async function fenced(){const status=await inspectD1WriteFence(connection,fence.plan);if(status.state!=='fenced')throw Error('RECOVERY_D1_NOT_FENCED');}
  await fenced();
  const journal=JSON.parse(await readFile(join(root,'apps/api/drizzle-d1/meta/_journal.json'),'utf8'));
  const expectedMigrations=z.array(z.object({tag:z.string().regex(/^\d{4}_[a-z0-9_]+$/)}).passthrough()).min(1).max(500).parse(journal.entries).map(value=>value.tag+'.sql').sort();
  const actualMigrations=(await d1query('SELECT name FROM d1_migrations ORDER BY name')).results;
  if(JSON.stringify(actualMigrations.map(value=>value.name))!==JSON.stringify(expectedMigrations))throw Error('RECOVERY_D1_MIGRATIONS_CHANGED');
  // Independently compare the complete frozen D1 snapshot, not only a supplied
  // file hash. Vector contents additionally remain bound to the trusted private
  // input reference and are checked against scene ownership by the DB child.
  if(!snapshot.rows||Object.keys(snapshot.rows).length!==manifest.target_insert_order.length)throw Error('RECOVERY_TABLE_INVENTORY_CHANGED');
  for(const name of manifest.target_insert_order){
   if(!/^[a-z][a-z0-9_]{0,100}$/.test(name)||!Array.isArray(snapshot.rows[name])||snapshot.rows[name].length>10000)throw Error('RECOVERY_TABLE_INVENTORY_CHANGED');
   const actual=(await d1query('SELECT * FROM "'+name+'" LIMIT 10001')).results;
   if(actual.length>10000||recoveryHash(actual.map(recoveryHash).sort())!==recoveryHash(snapshot.rows[name].map(recoveryHash).sort()))throw Error('RECOVERY_FROZEN_ROWS_CHANGED');
  }
  const sequences=(await d1query('SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name')).results;
  if(recoveryHash(Object.fromEntries(sequences.map(value=>[value.name,value.seq])))!==recoveryHash(snapshot.sequenceHighWater))throw Error('RECOVERY_SEQUENCE_STATE_CHANGED');
  await fenced();row=(await stopped()).row;await writeFile(state,row.postgres_fence_original_plan.S,{mode:0o600});
  const app=await readParameter('/videoq/prod/app'),admin=adminUrl((await readParameter('/videoq/security/prod/db-admin')).DATABASE_URL);
  const childEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));
  Object.assign(childEnv,{VIDEOQ_CUTOVER_RECOVERY_CHILD:'true',CODEBUILD_BUILD_ARN:env.CODEBUILD_BUILD_ARN,MAINTENANCE_RUN_ID:runId,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_RECOVERY_ACTION_ID:action,VIDEOQ_RECOVERY_INPUT_SHA256:ref.sha256Base64,VIDEOQ_FENCE_ADMIN_DATABASE_URL:admin,VIDEOQ_RECOVERY_R2_ACCESS_KEY_ID:app.R2_ACCESS_KEY_ID??app.AWS_ACCESS_KEY_ID,VIDEOQ_RECOVERY_R2_SECRET_ACCESS_KEY:app.R2_SECRET_ACCESS_KEY??app.AWS_SECRET_ACCESS_KEY,PGOPTIONS:'-c default_transaction_read_only=off -c search_path=pg_catalog'});
  const result=await child({command:process.execPath,args:['--import',pathToFileURL(join(root,'.github/operations-tools/node_modules/tsx/dist/loader.mjs')).href,join(root,'apps/api/scripts/d1-production-recovery.ts'),'--input',input,'--state',state,'--receipt',receipt],cwd:root,env:childEnv,onPrepared:async proof=>{
   if(proof.inputSha256!==ref.sha256Base64||proof.manifestSha256!==ref.manifestSha256||!hex.safeParse(proof.snapshotSha256).success)throw Error('RECOVERY_PREPARED_INPUT_CHANGED');
   await fenced();let before=(await stopped()).row;
   if(before.recovery_snapshot_sha256&&before.recovery_snapshot_sha256.S!==proof.snapshotSha256)throw Error('RECOVERY_PREPARED_INPUT_CHANGED');
   before=await save(before,{recovery_state:{S:'prepared'},recovery_snapshot_sha256:{S:proof.snapshotSha256},recovery_build_arn:{S:env.CODEBUILD_BUILD_ARN}});
   await fenced();const verified=(await stopped()).row;if(verified.recovery_snapshot_sha256?.S!==proof.snapshotSha256||verified.recovery_state.S!=='prepared'||verified.cutover_revision.N!==before.cutover_revision.N)throw Error('RECOVERY_GRANT_NOT_DURABLE');
  }});
  const serialized=(await readPrivateInput(receipt,65536)).toString(),saved=childReceipt.parse(JSON.parse(serialized));
  if(saved.version!==1||saved.runId!==runId||saved.sourceSha!==source||saved.actionId!==action||saved.inputSha256!==ref.sha256Base64||saved.manifestSha256!==ref.manifestSha256||saved.snapshotSha256!==result.prepared.snapshotSha256||saved.postgresLoginFenceVerified!==true||saved.productionSafe!==false||!hex.safeParse(saved.restoredSha256).success)throw Error('RECOVERY_CHILD_RECEIPT_CHANGED');
  await fenced();row=(await stopped()).row;if(row.recovery_state.S!=='prepared'||row.recovery_snapshot_sha256?.S!==saved.snapshotSha256)throw Error('RECOVERY_INTENT_CHANGED');
  await save(row,{recovery_state:{S:'restored'},recovery_receipt:{S:serialized},recovery_receipt_sha256:{S:digest(serialized)},recovery_build_arn:{S:env.CODEBUILD_BUILD_ARN}});
  return{restored:true,existingReceipt:false,productionSafe:false};
 }finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await runHeldPostwriteRecovery()));}catch{console.error('HELD_POSTWRITE_RECOVERY_FAILED_KEEP_WRITERS_STOPPED');process.exitCode=1;}}
