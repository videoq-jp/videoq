// Read-only proof for the serial trusted cutover operator. This is not a broker
// action or a general maintenance unlock. No DB credential or SQL is involved.
const {createHash}=require('node:crypto');
const {validateConsumerPlan,createConsumerControl}=require('./cutover-sqs-consumers.cjs');
const {validateDeploymentFreezePlan,createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
const {publicApiState}=require('./cutover-consumer-control.cjs');
const {verifyProductionTraffic}=require('./cutover-owned-api-traffic.cjs');
const TABLE='videoq-db-maintenance-prod';
const TARGET=Object.freeze({accountId:'12daec56fdba43f677f2766ee26a5a39',databaseId:'e57d0931-18cb-4f00-ae7f-b0068030fb04',databaseName:'videoq-d1-migration-staging-v4',bucket:'videoq-media-prod',largeIndex:'videoq-scenes-migration-v3-1536',smallIndex:'videoq-scenes-migration-v3-768'});
const hash=value=>createHash('sha256').update(value).digest('hex'),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const build=(value,kind)=>new RegExp('^arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-'+kind+'-prod:[a-f0-9-]{36}$').test(value??'');
function boundJson(row,key,shaKey=key+'_sha256'){const text=row[key]?.S;if(typeof text!=='string'||hash(text)!==row[shaKey]?.S)throw Error('CUTOVER_PROOF_CHANGED');return JSON.parse(text);}
async function assertTransferContext({run,source,aws,github,cloudflare,fetcher=fetch,expectedBackend='postgres'}){
 if(!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||!['postgres','d1'].includes(expectedBackend))throw Error('INVALID_TRANSFER_CONTEXT');
 const arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
 const get=pk=>aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:pk}},ConsistentRead:true});
 const [r,o]=await Promise.all([get('run#'+run),get('maintenance')]);const row=r.Item;
 if(row?.kind?.S!=='cutover-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==source||o.Item?.kind?.S!=='cutover-hold'||o.Item.execution_arn?.S!==arn||row.cutover_phase?.S!=='consumers-paused'||row.database_mutations_started?.BOOL!==true||row.release_requested?.BOOL!==false||row.postgres_fence_state?.S!=='fenced'||row.api_pause_verified?.BOOL!==true||['api_admission_restored','deployment_admission_restored','consumer_admission_restored'].some(k=>row[k]?.BOOL!==false))throw Error('OWNED_FROZEN_TRANSFER_REQUIRED');
 if(!/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N??'')||!Number.isSafeInteger(Number(row.cutover_revision.N))||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('CUTOVER_REVISION_REQUIRED');
 const original=row.postgres_fence_original_plan?.S;
 if(typeof original!=='string'||hash(original)!==row.postgres_fence_original_sha256?.S||row.postgres_fence_plan_sha256?.S!==row.postgres_fence_original_sha256.S)throw Error('ORIGINAL_POSTGRES_FENCE_CHANGED');
 const originalPlan=JSON.parse(original);if(originalPlan.version!==1||originalPlan.target?.purpose!=='production'||originalPlan.target?.host!=='ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech'||originalPlan.target?.databaseName!=='neondb'||originalPlan.target?.rolePrefix!=='videoq_')throw Error('ORIGINAL_POSTGRES_FENCE_CHANGED');
 const fenceText=row.postgres_fence_receipt?.S;if(typeof fenceText!=='string'||hash(fenceText)!==row.postgres_fence_receipt_sha256?.S)throw Error('NATIVE_POSTGRES_FENCE_REQUIRED');
 const fence=JSON.parse(fenceText);if(fence.state!=='fenced'||!Number.isSafeInteger(fence.writerLogins)||fence.writerLogins<1||['enabledWriterLogins','writerSessions','otherDatabaseSessions','unknownSessions','preparedTransactions'].some(k=>fence[k]!==0))throw Error('NATIVE_POSTGRES_FENCE_REQUIRED');
 const backup=boundJson(row,'final_backup_receipt');
 const keys=['version','sourceSha','runId','buildArn','sourceVersion','manifestVersion','archiveSha256','archiveFileSha256Base64','archiveBytes','postgresFenceSha256'];
 if(Object.keys(backup).sort().join(',')!==keys.sort().join(',')||backup.version!==1||backup.sourceSha!==source||!/^[a-f0-9]{32}$/.test(backup.runId??'')||!build(backup.buildArn,'backup')||typeof backup.sourceVersion!=='string'||backup.sourceVersion.length<1||backup.sourceVersion.length>1024||typeof backup.manifestVersion!=='string'||backup.manifestVersion.length<1||backup.manifestVersion==='null'||backup.manifestVersion.length>1024||!hex(backup.archiveSha256)||!/^[A-Za-z0-9+/]{43}=$/.test(backup.archiveFileSha256Base64??'')||!Number.isSafeInteger(backup.archiveBytes)||backup.archiveBytes<1||backup.archiveBytes>5*1024**3||backup.postgresFenceSha256!==row.postgres_fence_original_sha256.S||!build(row.postgres_fence_build_arn?.S,'rotation'))throw Error('FROZEN_BACKUP_RECEIPT_REQUIRED');
 const native=await aws('codebuild','BatchGetBuilds',{ids:[row.postgres_fence_build_arn.S,backup.buildArn]});
 if(native.buildsNotFound?.length||!Array.isArray(native.builds)||native.builds.length!==2)throw Error('NATIVE_FROZEN_BACKUP_REQUIRED');
 function finished(arn,project,expected){
  const found=native.builds.find(v=>v.arn===arn);if(!found||found.projectName!==project||found.buildStatus!=='SUCCEEDED'||found.buildComplete!==true||found.sourceVersion!==backup.sourceVersion||!Number.isFinite(Date.parse(found.startTime))||!Number.isFinite(Date.parse(found.endTime)))throw Error('NATIVE_FROZEN_BACKUP_REQUIRED');
  for(const [key,value]of Object.entries(expected)){const matches=found.environment?.environmentVariables?.filter(v=>v.name===key);if(matches?.length!==1||matches[0].type!=='PLAINTEXT'||matches[0].value!==value)throw Error('NATIVE_FROZEN_BACKUP_REQUIRED');}return found;
 }
 const installation=finished(row.postgres_fence_build_arn.S,'videoq-db-rotation-prod',{MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_KIND:'cutover-hold',MAINTENANCE_STAGE:'cutover-activity-audit',MAINTENANCE_ACTIVITY_ACTION_ID:row.postgres_fence_action_id?.S});
 const capture=finished(backup.buildArn,'videoq-db-backup-prod',{MAINTENANCE_RUN_ID:backup.runId,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_KIND:'backup',MAINTENANCE_STAGE:'backup'});
 if(Date.parse(capture.startTime)<Date.parse(installation.endTime)||Date.parse(capture.endTime)<Date.parse(capture.startTime))throw Error('BACKUP_MUST_FOLLOW_POSTGRES_FENCE');
 const deployment=validateDeploymentFreezePlan(boundJson(row,'deployment_freeze_plan','deployment_freeze_sha256')),consumer=validateConsumerPlan(JSON.parse(row.consumer_plan?.S??'null'));
 if(typeof row.consumer_plan?.S!=='string'||hash(row.consumer_plan.S)!==row.consumer_plan_sha256?.S||consumer.scope.purpose!=='production')throw Error('CUTOVER_CONSUMER_PLAN_CHANGED');
 const frozen=await createDeploymentFreeze(github).inspect(deployment);if(!frozen.admissionFrozen||!frozen.githubRunsDrained)throw Error('CUTOVER_DEPLOYMENT_FREEZE_REQUIRED');
 const stopped=await createConsumerControl((command,input)=>aws('lambda',command,input)).inspect(consumer);if(!stopped.admissionPaused)throw Error('CUTOVER_CONSUMERS_MUST_STAY_PAUSED');
 const settings=await cloudflare('GET','accounts/'+TARGET.accountId+'/workers/scripts/videoq-api/settings'),state=publicApiState(settings),backend=JSON.parse(state.serialized).vars;
 const selected=backend.PERSISTENCE_BACKEND??(backend.DEPLOYMENT_EDITION==='cloud'?'d1':'postgres');
 if(state.traffic!=='paused'||selected!==expectedBackend)throw Error('CUTOVER_API_BACKEND_OR_PAUSE_CHANGED');
 if(expectedBackend==='d1'){
  const database=settings.bindings.filter(v=>v.name==='DB');if(database.length!==1||database[0].type!=='d1'||database[0].id!==TARGET.databaseId)throw Error('CUTOVER_D1_TARGET_CHANGED');
 }
 await verifyProductionTraffic(true,fetcher);
 const [again,owner]=await Promise.all([get('run#'+run),get('maintenance')]);
 if(owner.Item?.execution_arn?.S!==arn||owner.Item?.kind?.S!=='cutover-hold'||again.Item?.source_sha?.S!==source||again.Item?.database_mutations_started?.BOOL!==true||again.Item?.cutover_revision?.N!==row.cutover_revision?.N||again.Item?.final_backup_receipt?.S!==row.final_backup_receipt.S)throw Error('CUTOVER_PROOF_CHANGED');
 return{row,backup,consumer,deployment,settings,executionArn:arn,target:TARGET};
}
module.exports={assertTransferContext,TARGET,TABLE};
