// Real DynamoDB Local CAS + actual migrated SQLite/fence. Remote AWS, Cloudflare,
// GitHub, R2 and PostgreSQL-child effects are explicit synthetic transports.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureOperatorDependencies} from './neon-fence-audit.mjs';
// Bootstrap the same minimal graph as the real job BEFORE ESM links any of the
// TS/schema/parent modules. CI deliberately installs no application packages.
await ensureOperatorDependencies(resolve(dirname(fileURLToPath(import.meta.url)),'../..'));
const [{runHeldPostwriteRecovery},{loadMigrationSnapshot},{buildMigrationManifest},{recoveryHash},{prepareD1WriteFence,installD1WriteFence}]=await Promise.all([
 import('./cutover-postwrite-recovery.mjs'),import('../../apps/api/scripts/d1-migration-manifest.ts'),import('../../apps/api/scripts/migrations/d1/manifest.ts'),import('../../apps/api/scripts/migrations/d1/postwrite-recovery.ts'),import('../../apps/api/scripts/migrations/d1/write-fence.ts'),
]);
const require=createRequire(import.meta.url),sdk=require('../../infra/db-maintenance/runtime/node_modules/@aws-sdk/client-dynamodb');
const {NodeHttpHandler}=require('../../infra/db-maintenance/runtime/node_modules/@smithy/node-http-handler');
const table='videoq-db-maintenance-prod',source='c'.repeat(40),databaseId='373d6ca5-2796-460d-8ab1-e644de46bb3c';
const image='amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86',name='videoq-recovery-ddb-'+randomUUID().replaceAll('-','');
const execute=promisify(execFile),docker=args=>execute('docker',args,{timeout:120000,maxBuffer:1024*1024}),sha=v=>createHash('sha256').update(v).digest('hex');
let client;
before(async()=>{
 await docker(['run','--detach','--name',name,'--label','videoq-purpose=postwrite-recovery-fixture','--memory','512m','-p','127.0.0.1::8000','--entrypoint','java','--workdir','/home/dynamodblocal',image,'-Xmx256m','-Djava.library.path=./DynamoDBLocal_lib','-jar','DynamoDBLocal.jar','-inMemory','-sharedDb']);
 const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.Config.Labels['videoq-purpose'],'postwrite-recovery-fixture');const port=info.NetworkSettings.Ports['8000/tcp'][0].HostPort;
 client=new sdk.DynamoDBClient({region:'ap-northeast-1',endpoint:'http://127.0.0.1:'+port,credentials:{accessKeyId:'DUMMYIDEXAMPLE',secretAccessKey:'DUMMYEXAMPLEKEY'},maxAttempts:1,requestHandler:new NodeHttpHandler({connectionTimeout:1000,socketTimeout:2000})});
 let ready=false;for(let i=0;i<60;i++){try{await client.send(new sdk.ListTablesCommand({Limit:1}));ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}assert.ok(ready);
 await client.send(new sdk.CreateTableCommand({TableName:table,KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST'}));
},{timeout:90000});
after(async()=>{client?.destroy();try{const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.Config.Labels['videoq-purpose'],'postwrite-recovery-fixture');await docker(['rm','--force','--volumes',name]);}catch(error){if(!String(error.stderr??'').includes('No such object'))throw error;}},{timeout:30000});
async function fixture(options={}){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const file of (await readdir('apps/api/drizzle-d1')).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile('apps/api/drizzle-d1/'+file,'utf8'));
 db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,applied_at TEXT)');
 const journal=JSON.parse(await readFile('apps/api/drizzle-d1/meta/_journal.json','utf8'));for(const entry of journal.entries)db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(entry.tag+'.sql');
 const manifest=buildMigrationManifest(await loadMigrationSnapshot('apps/api/drizzle'),await loadMigrationSnapshot('apps/api/drizzle-d1'));
 const local={databaseId,database:{prepare:sql=>({all:async()=>({success:true,results:db.prepare(sql).all()})}),batch:async statements=>Promise.all(statements.map(s=>s.all()))}};
 const fence=await prepareD1WriteFence(local,[...manifest.target_insert_order,'d1_migrations'].sort(),randomUUID().replaceAll('-',''));await installD1WriteFence(local,fence);
 const runId=randomUUID().replaceAll('-',''),action=randomUUID().replaceAll('-',''),arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+runId;
 const roles=[{oid:42,name:'videoq_api_synthetic',can_login:true,superuser:false,create_db:false,create_role:false,replication:false,bypass_rls:false,inherit:true,connection_limit:-1,valid_until:null}],memberships=[];
 const original=JSON.stringify({version:1,operationId:randomUUID(),target:{purpose:'production',host:'ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech',databaseName:'neondb',rolePrefix:'videoq_'},roles,memberships,catalogSha256:sha(JSON.stringify({roles:roles.map(r=>({...r,can_login:null})),memberships}))});
 const functions=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'];
 const consumer={version:1,operationId:randomUUID(),scope:{purpose:'production'},consumers:functions.map(functionName=>({functionName,functionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+functionName,queueArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+functionName,mappingUuid:randomUUID(),wasEnabled:true}))};
 const deployment={version:1,operationId:randomUUID(),repository:'videoq-jp/videoq',workflows:[{id:252628432,path:'.github/workflows/cd.yml',wasActive:true},{id:403417588,path:'.github/workflows/db-maintenance-cd.yml',wasActive:true}]};
 const snapshot={version:1,runId,sourceSha:source,actionId:action,manifestSha256:recoveryHash(manifest),d1Fence:{target:{version:1,accountId:'12daec56fdba43f677f2766ee26a5a39',databaseId,databaseName:'videoq-synthetic-recovery',purpose:'production'},manifestSha256:sha(JSON.stringify(manifest)),plan:fence},rows:Object.fromEntries(manifest.target_insert_order.map(n=>[n,db.prepare('SELECT * FROM "'+n+'"').all()])),vectors:[],sequenceHighWater:Object.fromEntries(db.prepare('SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence').all().map(v=>[v.name,v.seq]))};
 const bytes=Buffer.from(JSON.stringify(snapshot)),inputSha=createHash('sha256').update(bytes).digest('base64');
 const ref={version:1,runId,sourceSha:source,operatorSourceVersion:'synthetic-operator-version',actionId:action,key:'cutover-recovery/'+runId+'/'+action+'.json',versionId:'synthetic-version',bytes:bytes.length,sha256Base64:inputSha,manifestSha256:snapshot.manifestSha256,originalPlanSha256:sha(original),databaseId,databaseName:'videoq-synthetic-recovery'};
 const row={pk:{S:'run#'+runId},kind:{S:'cutover-hold'},execution_arn:{S:arn},source_sha:{S:source},recovery_action_id:{S:action},recovery_state:{S:'requested'},recovery_input_ref:{S:JSON.stringify(ref)},recovery_input_ref_sha256:{S:sha(JSON.stringify(ref))},cutover_phase:{S:'consumers-paused'},cutover_revision:{N:'1'},release_requested:{BOOL:false},database_mutations_started:{BOOL:true},postgres_fence_state:{S:'fenced'},postgres_fence_original_plan:{S:original},postgres_fence_original_sha256:{S:sha(original)},postgres_fence_plan_sha256:{S:sha(original)},api_pause_verified:{BOOL:true},api_admission_restored:{BOOL:false},deployment_admission_restored:{BOOL:false},consumer_admission_restored:{BOOL:false},consumer_plan:{S:JSON.stringify(consumer)},consumer_plan_sha256:{S:sha(JSON.stringify(consumer))},deployment_freeze_plan:{S:JSON.stringify(deployment)},deployment_freeze_sha256:{S:sha(JSON.stringify(deployment))}};
 const put=Item=>client.send(new sdk.PutItemCommand({TableName:table,Item}));await put(row);await put({pk:{S:'maintenance'},kind:{S:'cutover-hold'},execution_arn:{S:arn}});
 const get=async key=>(await client.send(new sdk.GetItemCommand({TableName:table,Key:{pk:{S:key}},ConsistentRead:true}))).Item;
 const env={CODEBUILD_SOURCE_VERSION:'synthetic-operator-version',PATH:process.env.PATH,HOME:process.env.HOME,VIDEOQ_CUTOVER_POSTWRITE_RECOVERY:'true',MAINTENANCE_KIND:'cutover-hold',MAINTENANCE_STAGE:'cutover-postwrite-recovery',MAINTENANCE_RUN_ID:runId,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_RECOVERY_ACTION_ID:action,MAINTENANCE_TABLE:table,CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:00000000-0000-4000-8000-000000000001',AWS_SECRET_ACCESS_KEY:'parent-only',NODE_OPTIONS:'parent-only',OPENROUTER_API_KEY:'parent-only',PGPASSWORD:'parent-only'};
 let dbWrites=0,childCalls=0,transactionCalls=0;
 const aws=async(service,command,value)=>{
  if(service==='lambda'){assert.equal(command,'list-event-source-mappings');const item=consumer.consumers.find(c=>c.functionName===value.FunctionName);return{EventSourceMappings:[{FunctionArn:item.functionArn,EventSourceArn:item.queueArn,UUID:item.mappingUuid,State:options.runningConsumer?'Enabled':'Disabled'}]};}
  assert.equal(service,'dynamodb');if(command==='get-item')return client.send(new sdk.GetItemCommand(value));assert.equal(command,'transact-write-items');transactionCalls++;
  if(options.ownerLostAtGrant){await put({pk:{S:'maintenance'},kind:{S:'cutover-hold'},execution_arn:{S:arn+'changed'}});}
  const result=await client.send(new sdk.TransactWriteItemsCommand(value));if(options.lostPersistenceResponse&&transactionCalls===1)throw Error('synthetic lost successful response');return result;
 };
 const fetcher=async(url,opts)=>{
  if(url.startsWith('https://api.github.com/')){const workflow=deployment.workflows.find(w=>url.includes('/'+w.id));assert.ok(workflow);return Response.json(url.includes('/runs?')?{total_count:0,workflow_runs:[]}:{id:workflow.id,path:workflow.path,state:options.activeDeployment?'active':'disabled_manually'});}
  if(new URL(url).origin==='https://videoq.jp')return url.endsWith('/health')?Response.json({data:{status:'ok'}}):Response.json({error:{code:'MIGRATION_PAUSED'}},{status:503,headers:{'retry-after':'60','cache-control':'no-store'}});
  if(url.endsWith('/settings'))return Response.json({success:true,result:{bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:options.runningApi?'running':'paused'},{name:'DB',type:'d1',id:databaseId},...[1536,768].map(n=>({name:'SCENE_VECTORIZE_'+n,type:'vectorize',index_name:'synthetic-'+n}))]}});
  if(url.endsWith('/query')){const {sql,params}=JSON.parse(opts.body);assert.deepEqual(params,[]);assert.match(sql,/^(SELECT |PRAGMA table_info\()/);const results=db.prepare(sql).all();return Response.json({success:true,result:[{success:true,results}]});}
  assert.ok(url.endsWith('/d1/database/'+databaseId));return Response.json({success:true,result:{uuid:databaseId,name:ref.databaseName}});
 };
 const child=async args=>{
  childCalls++;assert.equal(args.command,process.execPath);assert.equal(args.env.NODE_OPTIONS,undefined);assert.equal(args.env.AWS_SECRET_ACCESS_KEY,undefined);assert.equal(args.env.OPENROUTER_API_KEY,undefined);assert.equal(args.env.PGPASSWORD,undefined);assert.equal(args.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(args.env.VIDEOQ_RECOVERY_R2_SECRET_ACCESS_KEY,'synthetic-storage-only');
  const visualRecovery={objects:0,bytes:0,sha256:recoveryHash([])},snapshotSha256=recoveryHash({rows:snapshot.rows,vectors:[],sequenceHighWater:snapshot.sequenceHighWater,visualRecovery});
  await args.onPrepared({event:'recovery_prepared',snapshotSha256,manifestSha256:snapshot.manifestSha256,inputSha256:inputSha});
  const durable=await get('run#'+runId);assert.equal(durable.recovery_state.S,'prepared');assert.equal(durable.recovery_snapshot_sha256.S,snapshotSha256);assert.equal(durable.database_mutations_started.BOOL,true);assert.equal((await get('maintenance')).execution_arn.S,arn);dbWrites++;
  if(options.lostCommitResponse)throw Error('synthetic unknown child commit');
  const saved={version:1,runId,sourceSha:source,actionId:action,inputSha256:inputSha,snapshotSha256,manifestSha256:snapshot.manifestSha256,postgresLoginFenceVerified:true,restoredSha256:recoveryHash(snapshot.rows),visualRecovery,productionSafe:false};
  if(options.invalidReceipt)saved.unreviewedSecret='synthetic-value-must-not-enter-dynamodb';
  await writeFile(args.args.at(-1),JSON.stringify(saved),{mode:0o600});return{prepared:{snapshotSha256},committed:{snapshotSha256}};
 };
 const args={env,aws,root:process.cwd(),fetcher,child,readParameter:async name=>{
  if(name==='/videoq/security/prod/d1-migration')return{CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'synthetic-d1-only-credential'};
  if(name==='/videoq/prod/app')return{R2_ACCESS_KEY_ID:'synthetic-key',R2_SECRET_ACCESS_KEY:'synthetic-storage-only',OPENROUTER_API_KEY:'must-not-forward'};
  assert.equal(name,'/videoq/security/prod/db-admin');return{DATABASE_URL:'postgresql://neondb_owner:synthetic-db-only@ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'};
 },run:async(command,argv,opts)=>{assert.equal(command,'aws');assert.ok(argv.includes('--version-id=synthetic-version'));assert.equal(opts.env.NODE_OPTIONS,undefined);assert.ok(['get-object','head-object'].includes(argv[1]));if(argv[1]==='get-object')await writeFile(argv.at(-1),options.corruptInput?Buffer.concat([bytes,Buffer.from(' ')]):bytes,{mode:0o600});return{stdout:JSON.stringify({VersionId:'synthetic-version',ServerSideEncryption:'AES256',ContentLength:bytes.length,ChecksumSHA256:inputSha})};}};
 return{args,db,row,put,get,runId,arn,options,get dbWrites(){return dbWrites;},get childCalls(){return childCalls;},close:()=>db.close()};
}
test('real DDB transaction binds the prepared digest before the mocked PG child can write',async()=>{
 const f=await fixture();try{assert.deepEqual(await runHeldPostwriteRecovery(f.args),{restored:true,existingReceipt:false,productionSafe:false});const row=await f.get('run#'+f.runId);assert.equal(row.recovery_state.S,'restored');assert.equal(row.database_mutations_started.BOOL,true);assert.equal((await f.get('maintenance')).execution_arn.S,f.arn);assert.equal(f.dbWrites,1);}finally{f.close();}
});
test('a lost successful intent response reconciles by exact consistent readback',async()=>{
 const f=await fixture({lostPersistenceResponse:true});try{await runHeldPostwriteRecovery(f.args);assert.equal(f.dbWrites,1);assert.equal((await f.get('run#'+f.runId)).recovery_state.S,'restored');}finally{f.close();}
});
test('owner loss during the atomic grant rejects before the mocked database write',async()=>{
 const f=await fixture({ownerLostAtGrant:true});try{await assert.rejects(()=>runHeldPostwriteRecovery(f.args));assert.equal(f.dbWrites,0);assert.equal((await f.get('run#'+f.runId)).recovery_state.S,'requested');}finally{f.close();}
});
test('unknown child commit retains prepared intent and exclusion for an explicit same-input replay',async()=>{
 const f=await fixture({lostCommitResponse:true});try{await assert.rejects(()=>runHeldPostwriteRecovery(f.args));assert.equal(f.dbWrites,1);assert.equal((await f.get('run#'+f.runId)).recovery_state.S,'prepared');assert.equal((await f.get('maintenance')).execution_arn.S,f.arn);f.options.lostCommitResponse=false;await runHeldPostwriteRecovery(f.args);assert.equal(f.dbWrites,2);assert.equal((await f.get('run#'+f.runId)).recovery_state.S,'restored');}finally{f.close();}
});
test('corrupt private input, reopened deployments and active consumers never start the PG child',async()=>{
 for(const options of [{corruptInput:true},{activeDeployment:true},{runningConsumer:true},{runningApi:true}]){const f=await fixture(options);try{await assert.rejects(()=>runHeldPostwriteRecovery(f.args));assert.equal(f.childCalls,0);assert.equal(f.dbWrites,0);assert.equal((await f.get('maintenance')).execution_arn.S,f.arn);}finally{f.close();}}
});
test('a different prepared digest cannot replace an existing recovery intent',async()=>{
 const f=await fixture();try{await f.put({...f.row,recovery_state:{S:'prepared'},recovery_snapshot_sha256:{S:'f'.repeat(64)}});await assert.rejects(()=>runHeldPostwriteRecovery(f.args),/RECOVERY_PREPARED_INPUT_CHANGED/);assert.equal(f.dbWrites,0);assert.equal((await f.get('run#'+f.runId)).recovery_snapshot_sha256.S,'f'.repeat(64));}finally{f.close();}
});
test('unreviewed receipt fields are never persisted as a successful restore',async()=>{
 const f=await fixture({invalidReceipt:true});try{await assert.rejects(()=>runHeldPostwriteRecovery(f.args));const saved=await f.get('run#'+f.runId);assert.equal(f.dbWrites,1);assert.equal(saved.recovery_state.S,'prepared');assert.equal(saved.recovery_receipt,undefined);assert.equal(JSON.stringify(saved).includes('synthetic-value-must-not-enter-dynamodb'),false);assert.equal((await f.get('maintenance')).execution_arn.S,f.arn);}finally{f.close();}
});
test('GitHub, wrong-stage and wrong-project contexts reject before AWS or credential access',async()=>{
 const f=await fixture();try{
  for(const change of [{GITHUB_ACTIONS:'true'},{MAINTENANCE_STAGE:'prepare'},{CODEBUILD_BUILD_ARN:f.args.env.CODEBUILD_BUILD_ARN.replace('rotation-prod','smoke-prod')},{VIDEOQ_CUTOVER_POSTWRITE_RECOVERY:'false'}])await assert.rejects(()=>runHeldPostwriteRecovery({...f.args,env:{...f.args.env,...change},aws:()=>{throw Error('unexpected AWS access');},readParameter:()=>{throw Error('unexpected secret access');}}),/FIXED_AWS_HELD_RECOVERY_REQUIRED/);
  assert.equal(f.childCalls,0);
 }finally{f.close();}
});
test('D1 row drift and missing write-fence triggers reject before the PG child',async()=>{
 for(const drift of ['rows','fence']){const f=await fixture();try{
  const triggers=f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='users' AND name LIKE 'videoq_migration_fence_%'").all();
  if(drift==='fence')f.db.exec('DROP TRIGGER "'+triggers[0].name+'"');
  else{
   for(const trigger of triggers)f.db.exec('DROP TRIGGER "'+trigger.name+'"');
   const uuid=randomUUID();f.db.prepare("INSERT INTO users(id,username,email,name,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,'synthetic drift',0,0,0,0)").run(uuid,'synthetic_'+uuid,uuid+'@example.invalid');
   for(const trigger of triggers)f.db.exec(trigger.sql);
  }
  await assert.rejects(()=>runHeldPostwriteRecovery(f.args),drift==='rows'?/RECOVERY_FROZEN_ROWS_CHANGED/:/RECOVERY_D1_NOT_FENCED/);assert.equal(f.childCalls,0);assert.equal(f.dbWrites,0);
 }finally{f.close();}}
});
