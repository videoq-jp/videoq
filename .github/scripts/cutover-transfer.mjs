// Local trusted-main operator: import into the fixed offline candidate only.
// Production PG stays LOGIN-fenced; API and queues stay paused throughout.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtemp,chmod,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const {verifyReviewedSource,createAwsTransport,createGithubTransport}=require('./run-cutover-admission.cjs');
const {createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs');
const {assertTransferContext,TARGET,TABLE}=require('./cutover-final-context.cjs');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),hash=v=>createHash('sha256').update(v).digest('hex');
export function parseTransferArguments(args){
 if(args.length!==8)throw Error('INVALID_CUTOVER_TRANSFER_ARGUMENTS');const value={};
 for(let i=0;i<args.length;i+=2){if(!['--run','--source','--input','--mode'].includes(args[i])||Object.hasOwn(value,args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_CUTOVER_TRANSFER_ARGUMENTS');value[args[i]]=args[i+1];}
 if(!/^[a-f0-9]{32}$/.test(value['--run']??'')||!/^[a-f0-9]{40}$/.test(value['--source']??'')||!['import','deliver','verify'].includes(value['--mode']))throw Error('INVALID_CUTOVER_TRANSFER_ARGUMENTS');
 return{run:value['--run'],source:value['--source'],input:resolve(value['--input']),mode:value['--mode']};
}
export function immutableProductionVisualDestination(storage){
 // Generated chunk/publication versions are new keys; legacy source keys can
 // never be targets, including if an upstream planner regresses.
 const version='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
 const run='[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
 const allowed=new RegExp('\\.visual-v2/'+run+'/(?:[0-9]{1,3}/'+version+'\\.(?:bin|json)|publications/'+version+'/(?:manifest|overview)\\.json)$');
 return{read:(key,max)=>storage.read(key,max),create:async(key,bytes)=>{if(!allowed.test(key))throw Error('ONLY_NEW_VERSIONED_VISUAL_KEYS_ALLOWED');return storage.create(key,bytes);}};
}
async function recordTransfer({context,aws,key,value,immutable=false}){
 const row=context.row,run=context.run,serialized=JSON.stringify(value),sha=hash(serialized),next=String(Number(row.cutover_revision.N)+1);
 const values={':execution':row.execution_arn,':source':row.source_sha,':previous':row.cutover_revision,':next':{N:next},':backup':row.final_backup_receipt,':plan':row.postgres_fence_original_sha256,':true':{BOOL:true},':false':{BOOL:false},':phase':{S:'consumers-paused'},':fenced':{S:'fenced'},':value':{S:serialized},':sha':{S:sha}};
 const update={TableName:TABLE,Key:{pk:{S:'run#'+run}},UpdateExpression:'SET #field=:value,#sha=:sha,#revision=:next',ConditionExpression:'execution_arn=:execution AND source_sha=:source AND #revision=:previous AND final_backup_receipt=:backup AND postgres_fence_original_sha256=:plan AND database_mutations_started=:true AND release_requested=:false AND cutover_phase=:phase AND postgres_fence_state=:fenced AND api_pause_verified=:true AND api_admission_restored=:false AND consumer_admission_restored=:false AND deployment_admission_restored=:false'+(immutable?' AND ((attribute_not_exists(#field) AND attribute_not_exists(#sha)) OR (#field=:value AND #sha=:sha))':''),ExpressionAttributeNames:{'#field':key,'#sha':key+'_sha256','#revision':'cutover_revision'},ExpressionAttributeValues:values};
 const read=()=>aws('ddb','GetItem',{TableName:TABLE,Key:update.Key,ConsistentRead:true});
 try{await aws('ddb','TransactWriteItems',{TransactItems:[{Update:update},{ConditionCheck:{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn=:execution AND #kind=:kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':row.execution_arn,':kind':{S:'cutover-hold'}}}}]});}
 catch(error){const saved=(await read()).Item;if(saved?.cutover_revision?.N!==next||saved[key]?.S!==serialized||saved[key+'_sha256']?.S!==sha)throw error;}
 const [saved,owner]=await Promise.all([read(),aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConsistentRead:true})]);
 if(saved.Item?.cutover_revision?.N!==next||saved.Item[key]?.S!==serialized||saved.Item[key+'_sha256']?.S!==sha||owner.Item?.execution_arn?.S!==row.execution_arn.S||owner.Item?.kind?.S!=='cutover-hold')throw Error('CUTOVER_TRANSFER_RECEIPT_NOT_DURABLE');return saved.Item;
}
export async function main({args=process.argv.slice(2),env=process.env,operatorRoot=root,fetcher=fetch,verifySource=verifyReviewedSource,aws=createAwsTransport({env,root:operatorRoot}),github=createGithubTransport({env,root:operatorRoot}),connect}={}){
 const operation=parseTransferArguments(args);
 if(env.GITHUB_ACTIONS||env.VIDEOQ_AWS_CLI||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL)throw Error('LOCAL_REVIEWED_CUTOVER_OPERATOR_REQUIRED');
 await verifySource({source:operation.source,root:operatorRoot,env});
 if((await aws('sts','GetCallerIdentity',{})).Account!=='257240362763'||env.CLOUDFLARE_ACCOUNT_ID&&env.CLOUDFLARE_ACCOUNT_ID!==TARGET.accountId)throw Error('FIXED_CUTOVER_ACCOUNT_REQUIRED');
 const cloudflare=createCloudflareTrafficTransport(env.CLOUDFLARE_API_TOKEN,{fetcher});
 const proof=()=>assertTransferContext({...operation,aws,github,cloudflare,fetcher});
 let context={...await proof(),run:operation.run};
 const [{loadMigrationSnapshot},{buildMigrationManifest},{prepareCommonImport},{openPrivateInput},{importCommonTables},{runStagingMigration},{r2VisualMigrationStorage}]=await Promise.all([
  import(pathToFileURL(join(operatorRoot,'apps/api/scripts/d1-migration-manifest.ts')).href),import(pathToFileURL(join(operatorRoot,'apps/api/scripts/migrations/d1/manifest.ts')).href),import(pathToFileURL(join(operatorRoot,'apps/api/scripts/migrations/d1/prepare-import.ts')).href),import(pathToFileURL(join(operatorRoot,'apps/api/scripts/migrations/d1/private-input.ts')).href),import(pathToFileURL(join(operatorRoot,'apps/api/scripts/migrations/d1/import-common.ts')).href),import(pathToFileURL(join(operatorRoot,'apps/api/scripts/migrations/d1/staging-migration.ts')).href),import(pathToFileURL(join(operatorRoot,'apps/api/scripts/migrations/d1/r2-visual-storage.ts')).href),
 ]);
 const manifest=buildMigrationManifest(await loadMigrationSnapshot(join(operatorRoot,'apps/api/drizzle')),await loadMigrationSnapshot(join(operatorRoot,'apps/api/drizzle-d1')));
 if(!manifest.mapping_complete)throw Error('COMPLETE_CUTOVER_MAPPING_REQUIRED');
 const prepared=await prepareCommonImport(operation.input,manifest);let directory;
 try{
  if(prepared.verified.archive_sha256!==context.backup.archiveSha256)throw Error('FROZEN_BACKUP_ARCHIVE_CHANGED');
  const privateInput=join(prepared.directory,'source.videoq-export.ndjson'),opened=await openPrivateInput(privateInput,5*1024**3);const digest=createHash('sha256');let size=0;
  try{const buffer=Buffer.alloc(64*1024);for(;;){const {bytesRead}=await opened.file.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;digest.update(buffer.subarray(0,bytesRead));}if(size!==opened.info.size)throw Error('FROZEN_BACKUP_ARCHIVE_CHANGED');}finally{await opened.file.close();}
  if(size!==context.backup.archiveBytes||digest.digest('base64')!==context.backup.archiveFileSha256Base64)throw Error('FROZEN_BACKUP_ARCHIVE_CHANGED');
  const intent={version:1,runId:operation.run,sourceSha:operation.source,archiveSha256:context.backup.archiveSha256,manifestSha256:hash(JSON.stringify(manifest)),target:TARGET};
  context={...await proof(),run:operation.run};await recordTransfer({context,aws,key:'transfer_intent',value:intent,immutable:true});context={...await proof(),run:operation.run};
  directory=await mkdtemp(join(tmpdir(),'videoq-held-transfer-'));await chmod(directory,0o700);const configPath=join(directory,'wrangler.json');
  const config={name:'videoq-cutover-transfer-operator',account_id:TARGET.accountId,main:join(operatorRoot,'apps/api/scripts/migrations/d1/staging-proxy.ts'),compatibility_date:'2026-11-14',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,routes:[],d1_databases:[{binding:'DB',database_name:TARGET.databaseName,database_id:TARGET.databaseId,remote:true}],vectorize:[{binding:'SCENE_VECTORIZE_1536',index_name:TARGET.largeIndex,remote:true},{binding:'SCENE_VECTORIZE_768',index_name:TARGET.smallIndex,remote:true}],r2_buckets:[{binding:'SOURCE_VIDEO_BUCKET',bucket_name:TARGET.bucket,remote:true},{binding:'VIDEO_BUCKET',bucket_name:TARGET.bucket,remote:true}]};
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const openProxy=connect??(async()=>{const {getPlatformProxy}=await import('wrangler');return getPlatformProxy({configPath,envFiles:[],persist:false,remoteBindings:true});});
  let result;
  if(operation.mode==='import'){
   const proxy=await openProxy();
   try{
    const source=r2VisualMigrationStorage(proxy.env.SOURCE_VIDEO_BUCKET),destination=immutableProductionVisualDestination(r2VisualMigrationStorage(proxy.env.VIDEO_BUCKET));
    result=await importCommonTables(proxy.env.DB,privateInput,manifest,{offlineStaging:true,visualStorage:{source:{read:(key,max)=>source.read(key,max)},destination}});
    if(result.common_import_complete!==true||result.scene_import_complete!==true||result.checkpoint_import_complete!==true||result.visual_objects_migrated!==true||result.pending_visual_runs!=='0'||result.pending_sequence_restore!==false)throw Error('CUTOVER_IMPORT_INCOMPLETE');
   }finally{await proxy.dispose();}
  }else{
   result=await runStagingMigration({mode:operation.mode,input:privateInput,maxTasks:10000,allowPendingVisuals:false},manifest,openProxy);
   if(operation.mode==='verify'?result.vectorize_delivery_complete!==true:result.failed!==0||result.leaseLost!==0||result.pending_tasks!==0)throw Error('CUTOVER_VECTOR_DELIVERY_INCOMPLETE');
  }
  context={...await proof(),run:operation.run};
  const receipt={version:1,runId:operation.run,sourceSha:operation.source,archiveSha256:context.backup.archiveSha256,target:TARGET,phase:operation.mode,complete:true,productionActive:false};
  await recordTransfer({context,aws,key:'transfer_'+operation.mode+'_receipt',value:receipt});
  return{phase:operation.mode,complete:true,productionActive:false};
 }finally{await prepared.dispose();if(directory)await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await main()));}catch{console.error('HELD_CUTOVER_TRANSFER_FAILED_KEEP_WRITERS_STOPPED');process.exitCode=1;}}
