// Real DynamoDB Local transactions; Step Functions/CodeBuild observations are
// explicit test transports. No production endpoint or credential provider is used.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const sdk=require('../../infra/db-maintenance/runtime/node_modules/@aws-sdk/client-dynamodb');
const {NodeHttpHandler}=require('../../infra/db-maintenance/runtime/node_modules/@smithy/node-http-handler');
const {createBroker}=require('../../infra/db-maintenance/runtime/broker.cjs');
const {definition}=require('../../infra/db-maintenance/state-machine.cjs');
const {HOLD_KIND,executionArn}=require('../../infra/db-maintenance/runtime/policy.cjs');
const MACHINE='arn:aws:states:ap-northeast-1:257240362763:stateMachine:videoq-db-maintenance-prod',SHA='a'.repeat(40);
const IMAGE='amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86';
const name='videoq-hold-ddb-'+randomUUID().replaceAll('-',''),execute=promisify(execFile);
const docker=args=>execute('docker',args,{timeout:120000,maxBuffer:1024*1024});
let client,operatorRoot;
before(async()=>{
 const fs=require('node:fs/promises'),path=require('node:path');
 operatorRoot=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'videoq-held-operator-fixture-'));
 await fs.chmod(operatorRoot,0o700);
 await fs.mkdir(path.join(operatorRoot,'.github/operations-tools'),{recursive:true});
 await fs.symlink(path.resolve('.github/operations-tools/node_modules'),path.join(operatorRoot,'.github/operations-tools/node_modules'),'dir');
 await fs.writeFile(path.join(operatorRoot,'package.json'),JSON.stringify({type:'module',private:true}));
 const schemas=path.join('apps/api/scripts/migrations/d1');await fs.mkdir(path.join(operatorRoot,schemas),{recursive:true});
 for(const name of ['postgres-login-fence.ts','postgres-cutover-activity.ts','private-input.ts'])await fs.copyFile(path.join(schemas,name),path.join(operatorRoot,schemas,name));
 await docker(['run','--detach','--name',name,'--label','videoq-purpose=cutover-hold-ddb-fixture','--memory','512m','-p','127.0.0.1::8000','--entrypoint','java','--workdir','/home/dynamodblocal',IMAGE,'-Xmx256m','-Djava.library.path=./DynamoDBLocal_lib','-jar','DynamoDBLocal.jar','-inMemory','-sharedDb']);
 const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.Config.Labels['videoq-purpose'],'cutover-hold-ddb-fixture');
 const port=Number(info.NetworkSettings.Ports['8000/tcp'][0].HostPort);assert.ok(Number.isInteger(port)&&port>0&&port<65536);
 client=new sdk.DynamoDBClient({region:'ap-northeast-1',endpoint:'http://127.0.0.1:'+port,credentials:{accessKeyId:'DUMMYIDEXAMPLE',secretAccessKey:'DUMMYEXAMPLEKEY'},maxAttempts:1,requestHandler:new NodeHttpHandler({connectionTimeout:1000,socketTimeout:2000})});
 const until=Date.now()+60000;let ready=false;
 while(Date.now()<until){try{await client.send(new sdk.ListTablesCommand({Limit:1}));ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
 assert.ok(ready,'owned DynamoDB Local did not become ready');
}, {timeout:90000});
after(async()=>{
 client?.destroy();
 if(operatorRoot)await require('node:fs/promises').rm(operatorRoot,{recursive:true,force:true});
 try{const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.Config.Labels['videoq-purpose'],'cutover-hold-ddb-fixture');await docker(['rm','--force','--volumes',name]);}
 catch(error){if(!String(error.stderr||'').includes('No such object'))throw error;}
}, {timeout:30000});
async function fixture({consumerControlEnabled=false,listBuilds,boundDefinition}={}){
 const table='videoq_hold_'+randomUUID().replaceAll('-','');
 await client.send(new sdk.CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}]}));
 const states=new Map(),calls=[],redrives=new Map();let active=false,describe;
 const aws=async(service,command,value)=>{
  calls.push({service,command,value});
  if(service==='ddb')return client.send(new sdk[command+'Command'](value));
  if(service==='codebuild'&&command==='ListBuildsForProject'&&value.nextToken&&Object.hasOwn(value,'sortOrder'))throw Object.assign(Error('sortOrder cannot accompany nextToken'),{name:'InvalidInputException'});
  if(service==='codebuild')return command==='ListBuildsForProject'?(listBuilds?listBuilds(value):{ids:active?['owned-test-build']:[]}):{builds:value.ids.map(id=>({buildComplete:!active&&id!=='active-late'}))};
  if(service==='sfn'&&command==='GetExecutionHistory'){const run=value.executionArn.split(':db-')[1],row=(await client.send(new sdk.GetItemCommand({TableName:table,Key:{pk:{S:'run#'+run}},ConsistentRead:true}))).Item,arn=row.cutover_last_build_arn?.S;return{events:!active&&arn?[{type:'TaskSucceeded',taskSucceededEventDetails:{resourceType:'codebuild',resource:'startBuild.sync',output:JSON.stringify({Build:{BuildStatus:'SUCCEEDED',Arn:arn,Id:arn.split(':build/')[1]}})}}]:[]};}
  if(service==='sfn'&&command==='DescribeStateMachineForExecution')return {definition:JSON.stringify(typeof boundDefinition==='function'?boundDefinition(table):boundDefinition??definition({table,projects:{}}))};
  if(service==='sfn'&&command==='RedriveExecution'){redrives.set(value.executionArn,(redrives.get(value.executionArn)??0)+1);states.set(value.executionArn,'RUNNING');return {}; }
  if(service==='sfn'&&command==='StartExecution'){states.set(executionArn(MACHINE,value.name),'RUNNING');return {};}
  if(service==='sfn'&&command==='DescribeExecution'){
   const status=describe?describe(value.executionArn):states.get(value.executionArn);
   if(!status)throw Object.assign(Error('missing test execution'),{name:'ExecutionDoesNotExist'});return {status,redriveStatus:'REDRIVABLE',redriveCount:redrives.get(value.executionArn)??0};
  }
  throw Error('Unexpected test AWS operation');
 };
 const broker=createBroker(aws,{table,machine:MACHINE,projects:['rotation','migration'],consumerControlEnabled,expectedDefinitionHash:require('../../infra/db-maintenance/runtime/cutover-hold.cjs').definitionHash(definition({table,projects:{}})),allowedKinds:['rotate','rollback','audit','migration','backup','smoke','deploy',HOLD_KIND]},async()=>SHA);
 const get=async key=>(await client.send(new sdk.GetItemCommand({TableName:table,Key:{pk:{S:key}},ConsistentRead:true}))).Item;
 const put=Item=>client.send(new sdk.PutItemCommand({TableName:table,Item}));
 const start=()=>broker({action:'start',kind:HOLD_KIND,source_sha:SHA,client_token:'b'.repeat(32)});
 function taskParameters(run,arn){
  const task=definition({table,projects:{}}).States.ReleaseCutoverHold;
  assert.equal(task.Resource,'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems');
  const visit=value=>{
   if(Array.isArray(value))return value.map(visit);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>{
    if(!key.endsWith('.$'))return [key==='Bool'?'BOOL':key,visit(v)];
    assert.ok(["States.Format('run#{}', $.run_id)",'$$.Execution.Id'].includes(v));return [key.slice(0,-2),v==='$$.Execution.Id'?arn:'run#'+run];
   }));return value;
  };return visit(task.Parameters);
 }
 return {table,broker,get,put,start,calls,states,aws,set active(v){active=v;},set describe(v){describe=v;},async finish(run){const arn=executionArn(MACHINE,'db-'+run);await client.send(new sdk.TransactWriteItemsCommand(taskParameters(run,arn)));states.set(arn,'SUCCEEDED');},async close(){await client.send(new sdk.DeleteTableCommand({TableName:table}));}};
}
test('holds maintenance without TTL and blocks normal operations until atomic explicit release',async()=>{
 const f=await fixture();try{
  const result=await f.start(),run=result.run_id,arn=executionArn(MACHINE,'db-'+run);assert.equal(result.status,'RUNNING');
  const row=await f.get('run#'+run),owner=await f.get('maintenance');assert.equal(row.expires_at,undefined);assert.equal(owner.expires_at,undefined);assert.equal(row.cutover_phase.S,'holding');assert.equal(row.release_requested.BOOL,false);
  for(const kind of ['rotate','backup','deploy'])assert.equal((await f.broker({action:'start',kind,...(kind==='deploy'?{source_sha:SHA}:{})})).status,'BUSY');
  const again=await f.start();assert.equal(again.run_id,run);assert.equal(f.calls.filter(c=>c.command==='StartExecution').length,1);
  await f.broker({action:'release-cutover-hold',run_id:run});assert.equal((await f.get('maintenance')).execution_arn.S,arn);assert.equal((await f.get('run#'+run)).release_requested.BOOL,true);
  await f.finish(run);assert.equal(await f.get('maintenance'),undefined);assert.equal((await f.broker({action:'release-cutover-hold',run_id:run})).status,'SUCCEEDED');
 }finally{await f.close();}
});
test('competing release requests cannot lose the request or delete a different owner',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start();const results=await Promise.allSettled([f.broker({action:'release-cutover-hold',run_id:run}),f.broker({action:'release-cutover-hold',run_id:run})]);
  assert.ok(results.some(r=>r.status==='fulfilled'));for(const r of results)if(r.status==='rejected')assert.match(r.reason.message,/STATE_CHANGED/);
  const row=await f.get('run#'+run);assert.equal(row.cutover_revision.N,'1');assert.equal(row.release_requested.BOOL,true);
  const other={pk:{S:'maintenance'},kind:{S:'rotate'},execution_arn:{S:executionArn(MACHINE,'db-'+'c'.repeat(32))}};await f.put(other);
  await assert.rejects(f.finish(run),{name:'TransactionCanceledException'});assert.deepEqual(await f.get('maintenance'),other);
 }finally{await f.close();}
});
test('a changed mutation phase prevents both workflow release and control recovery',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start();await f.broker({action:'release-cutover-hold',run_id:run});const row=await f.get('run#'+run);await f.put({...row,cutover_phase:{S:'neon-fenced'}});
  await assert.rejects(f.finish(run),{name:'TransactionCanceledException'});assert.ok(await f.get('maintenance'));
  await assert.rejects(f.broker({action:'recover-cutover-hold',run_id:run}),/INVALID_CUTOVER_HOLD_RECORD/);
 }finally{await f.close();}
});
test('terminal holds are never stolen; recovery waits for actual build completion',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start(),arn=executionArn(MACHINE,'db-'+run);f.states.set(arn,'TIMED_OUT');
  await assert.rejects(f.broker({action:'start',kind:'rotate'}),/CUTOVER_RECOVERY_REQUIRED/);assert.ok(await f.get('maintenance'));
  f.active=true;await assert.rejects(f.broker({action:'recover-cutover-hold',run_id:run}),/PREVIOUS_BUILD_STILL_RUNNING/);assert.equal((await f.get('run#'+run)).cutover_phase.S,'recovering');assert.ok(await f.get('maintenance'));
  f.active=false;assert.equal((await f.broker({action:'recover-cutover-hold',run_id:run})).status,'RECOVERED');assert.equal(await f.get('maintenance'),undefined);
  assert.equal((await f.broker({action:'recover-cutover-hold',run_id:run})).status,'RECOVERED');assert.equal((await f.broker({action:'status',run_id:run})).status,'RECOVERED');
 }finally{await f.close();}
});
test('a late execution observation preserves the recovery claim and prevents restart',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start(),arn=executionArn(MACHINE,'db-'+run);let reads=0;f.describe=()=>++reads===1?undefined:'RUNNING';
  await assert.rejects(f.broker({action:'recover-cutover-hold',run_id:run}),/EXECUTION_STILL_RUNNING/);assert.equal((await f.get('run#'+run)).cutover_phase.S,'recovering');assert.ok(await f.get('maintenance'));
  await assert.rejects(f.start(),/CUTOVER_RECOVERY_REQUIRED/);assert.equal(f.calls.filter(c=>c.command==='StartExecution').length,1);
  f.describe=undefined;f.states.set(arn,'ABORTED');await f.broker({action:'recover-cutover-hold',run_id:run});assert.equal(await f.get('maintenance'),undefined);
 }finally{await f.close();}
});
test('recovery never clears another owner, and new holds reject active builds or wrong sources',async()=>{
 const f=await fixture();try{
  f.active=true;await assert.rejects(f.start(),/PREVIOUS_BUILD_STILL_RUNNING/);assert.equal(await f.get('maintenance'),undefined);f.active=false;
  await assert.rejects(f.broker({action:'start',kind:HOLD_KIND,source_sha:'f'.repeat(40)}),/CURRENT_MAIN/);
  const {run_id:run}=await f.start(),arn=executionArn(MACHINE,'db-'+run);f.states.set(arn,'FAILED');
  const other={pk:{S:'maintenance'},kind:{S:'rotate'},execution_arn:{S:executionArn(MACHINE,'db-'+'d'.repeat(32))}};await f.put(other);
  await f.broker({action:'recover-cutover-hold',run_id:run});assert.deepEqual(await f.get('maintenance'),other);
 }finally{await f.close();}
});

const {prepareConsumers}=require('./cutover-consumer-prepare.cjs');
function preparation(f,run,{beforeCommit,loseResponse=false,disabledAccount=false}={}){
 const env={MAINTENANCE_KIND:HOLD_KIND,MAINTENANCE_STAGE:'cutover-consumer-prepare',MAINTENANCE_TABLE:'videoq-db-maintenance-prod',MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:SHA,CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:11111111-2222-4333-8444-555555555555'};
 let reads=0;
 const rename=value=>Array.isArray(value)?value.map(rename):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='TableName'?f.table:rename(v)])):value;
 const aws=async(service,command,value)=>{
  if(service==='lambda'){
   assert.equal(command,'list-event-source-mappings');reads++;
   const names=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'],i=names.indexOf(value.FunctionName);assert.ok(i>=0);
   return{EventSourceMappings:[{UUID:'11111111-2222-4333-8444-55555555555'+i,FunctionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+value.FunctionName,EventSourceArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+value.FunctionName,State:disabledAccount&&i===2?'Disabled':'Enabled'}]};
  }
  assert.equal(service,'dynamodb');
  if(command==='get-item')return client.send(new sdk.GetItemCommand(rename(value)));
  assert.equal(command,'transact-write-items');if(beforeCommit)await beforeCommit();
  const result=await client.send(new sdk.TransactWriteItemsCommand(rename(value)));if(loseResponse)throw Error('lost successful response');return result;
 };
 return{env,aws,get reads(){return reads;},run:()=>prepareConsumers({env,aws})};
}
test('consumer preparation persists one immutable plan while the hold retains ownership',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});assert.equal((await f.get('run#'+run)).cutover_phase.S,'consumer-preparing');
  await assert.rejects(f.broker({action:'release-cutover-hold',run_id:run}),/RECOVERY/);await assert.rejects(f.finish(run));
  const stage=preparation(f,run);assert.equal((await stage.run()).consumers,3);const first=await f.get('run#'+run);assert.equal(first.cutover_phase.S,'holding');assert.equal(stage.reads,3);assert.equal(first.expires_at,undefined);
  await stage.run();assert.equal(stage.reads,3);assert.equal((await f.get('run#'+run)).consumer_plan.S,first.consumer_plan.S);
  assert.equal((await f.broker({action:'prepare-cutover-consumers',run_id:run})).consumer_prepared,true);assert.equal((await f.broker({action:'status',run_id:run})).consumer_prepared,true);
  await f.broker({action:'release-cutover-hold',run_id:run});await f.finish(run);assert.equal(await f.get('maintenance'),undefined);
 }finally{await f.close();}
});
test('competing preparation requests cannot overwrite the phase or release the hold',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start(),request={action:'prepare-cutover-consumers',run_id:run};const results=await Promise.allSettled([f.broker(request),f.broker(request)]);assert.ok(results.some(r=>r.status==='fulfilled'));
  assert.equal((await f.get('run#'+run)).cutover_phase.S,'consumer-preparing');assert.equal((await f.get('run#'+run)).release_requested.BOOL,false);
 }finally{await f.close();}
});
test('a changed global owner blocks the real preparation transaction without writing a plan',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});const other='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+'f'.repeat(32);
  const stage=preparation(f,run,{beforeCommit:async()=>{const owner=await f.get('maintenance');await f.put({...owner,execution_arn:{S:other}});}});
  await assert.rejects(stage.run());assert.equal((await f.get('run#'+run)).consumer_plan,undefined);assert.equal((await f.get('maintenance')).execution_arn.S,other);
 }finally{await f.close();}
});
test('a lost successful preparation transaction response is reconciled by exact plan readback',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});const stage=preparation(f,run,{loseResponse:true});assert.equal((await stage.run()).consumer_prepared,true);assert.equal((await f.get('run#'+run)).cutover_phase.S,'holding');
 }finally{await f.close();}
});
test('corrupt prepared records are rejected instead of being overwritten or reported ready',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});const stage=preparation(f,run);await stage.run();const row=await f.get('run#'+run);await f.put({...row,consumer_plan_sha256:{S:'f'.repeat(64)}});
  await assert.rejects(stage.run(),/INVALID_CONSUMER_PLAN_RECORD/);await assert.rejects(f.broker({action:'status',run_id:run}),/INVALID_CONSUMER_PLAN_RECORD/);assert.equal((await f.get('run#'+run)).consumer_plan.S,row.consumer_plan.S);
 }finally{await f.close();}
});
test('failed readonly preparation requires explicit terminal recovery and no active builds',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});f.states.set(executionArn(MACHINE,'db-'+run),'FAILED');f.active=true;
  await assert.rejects(f.broker({action:'recover-cutover-hold',run_id:run}),/PREVIOUS_BUILD_STILL_RUNNING/);assert.ok(await f.get('maintenance'));
  f.active=false;assert.equal((await f.broker({action:'recover-cutover-hold',run_id:run})).status,'RECOVERED');assert.equal(await f.get('maintenance'),undefined);
 }finally{await f.close();}
});

const {controlConsumers}=require('./cutover-consumer-control.cjs');
async function consumerStage(f,run,stage,{rows,api,failAt=0,loseCompletion=false}={}){
 const row=await f.get('run#'+run),plan=JSON.parse(row.consumer_plan.S);
 rows??=plan.consumers.map(c=>({UUID:c.mappingUuid,FunctionArn:c.functionArn,EventSourceArn:c.queueArn,State:c.wasEnabled?'Enabled':'Disabled'}));
 api??={traffic:'paused',hyperdrive:'a'.repeat(32),ready:true};let updates=0;
 const env={VIDEOQ_CUTOVER_CONSUMER_CONTROL:'true',MAINTENANCE_KIND:HOLD_KIND,MAINTENANCE_STAGE:'cutover-consumer-'+stage,MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:SHA,MAINTENANCE_CONSUMER_ACTION_ID:row.consumer_action_id.S,MAINTENANCE_TABLE:'videoq-db-maintenance-prod',CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:11111111-2222-4333-8444-555555555555'};
 const rename=value=>Array.isArray(value)?value.map(rename):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='TableName'?f.table:rename(v)])):value;
 const aws=async(service,command,value)=>{
  if(service==='lambda'){
   if(command==='list-event-source-mappings')return{EventSourceMappings:rows.filter(r=>r.FunctionArn.endsWith(':'+value.FunctionName))};
   assert.equal(command,'update-event-source-mapping');updates++;if(updates===failAt)throw Error('synthetic partial mutation failure');rows.find(r=>r.UUID===value.UUID).State=value.Enabled?'Enabled':'Disabled';return{};
  }
  assert.equal(service,'dynamodb');if(command==='get-item')return client.send(new sdk.GetItemCommand(rename(value)));
  assert.equal(command,'transact-write-items');const result=await client.send(new sdk.TransactWriteItemsCommand(rename(value)));
  if(loseCompletion&&value.TransactItems[0].Update.UpdateExpression.includes('consumer_admission_restored'))throw Error('lost completion response');return result;
 };
 const fetcher=async(url,options)=>{
  if(url==='https://videoq.jp/ready'){assert.equal(options.headers,undefined);return Response.json({data:{status:api.ready?'ready':'unready',db:'ok'}},{status:api.ready?200:503});}
  assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/12daec56fdba43f677f2766ee26a5a39/workers/scripts/videoq-api/settings');
  return Response.json({success:true,result:{bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'HYPERDRIVE',type:'hyperdrive',id:api.hyperdrive},...(api.traffic===undefined?[]:[{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:api.traffic}])]}});
 };
 return{env,rows,api,get updates(){return updates;},run:()=>controlConsumers({env,aws,fetcher,readParameter:name=>{assert.equal(name,'/videoq/security/prod/cutover-control');return{CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'synthetic-cutover-token-0123456789'};}})};
}
async function preparedControl(){const f=await fixture({consumerControlEnabled:true});const {run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});await preparation(f,run,{disabledAccount:true}).run();return{f,run};}
test('consumer pause/resume holds exclusion until original admission and API backend are verified',async()=>{
 const {f,run}=await preparedControl();try{
  await f.broker({action:'pause-cutover-consumers',run_id:run});const paused=await consumerStage(f,run,'pause');assert.equal((await paused.run()).consumers_paused,true);assert.equal(paused.updates,2);
  assert.equal((await f.broker({action:'status',run_id:run})).consumers_paused,true);await assert.rejects(f.broker({action:'release-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);
  await f.broker({action:'resume-cutover-consumers',run_id:run});paused.api.traffic='running';const resumed=await consumerStage(f,run,'resume',{rows:paused.rows,api:paused.api});assert.equal((await resumed.run()).consumers_restored,true);assert.equal(resumed.updates,2);assert.equal(resumed.rows[2].State,'Disabled');
  assert.equal((await f.get('run#'+run)).cutover_phase.S,'holding');assert.equal((await f.broker({action:'status',run_id:run})).consumers_restored,true);await f.broker({action:'release-cutover-hold',run_id:run});await f.finish(run);
 }finally{await f.close();}
});
test('partial pause failure cannot unlock and redrives the same execution with the same saved plan',async()=>{
 const {f,run}=await preparedControl();try{
  await f.broker({action:'pause-cutover-consumers',run_id:run});const failing=await consumerStage(f,run,'pause',{failAt:2});await assert.rejects(failing.run());assert.equal(failing.rows[0].State,'Disabled');assert.equal(failing.rows[1].State,'Enabled');const before=await f.get('run#'+run),arn=executionArn(MACHINE,'db-'+run);f.states.set(arn,'FAILED');
  await assert.rejects(f.broker({action:'recover-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);await assert.rejects(f.broker({action:'start',kind:'backup'}),/RECOVERY_REQUIRED/);f.active=true;await assert.rejects(f.broker({action:'retry-cutover-consumers',run_id:run}),/PREVIOUS_BUILD_STILL_RUNNING/);f.active=false;
  assert.equal((await f.broker({action:'retry-cutover-consumers',run_id:run})).consumer_retry_accepted,true);assert.equal(f.calls.filter(c=>c.command==='StartExecution').length,1);assert.equal(f.calls.filter(c=>c.command==='RedriveExecution').length,1);
  await f.broker({action:'retry-cutover-consumers',run_id:run});assert.equal(f.calls.filter(c=>c.command==='RedriveExecution').length,1);
  const retry=await consumerStage(f,run,'pause',{rows:failing.rows,api:failing.api});assert.equal((await retry.run()).consumers_paused,true);assert.equal(retry.updates,1);assert.equal((await f.get('run#'+run)).consumer_plan.S,before.consumer_plan.S);assert.ok(await f.get('maintenance'));
 }finally{await f.close();}
});
test('resume refuses paused/unready API and backend replacement before enabling any consumer',async()=>{
 const {f,run}=await preparedControl();try{
  await f.broker({action:'pause-cutover-consumers',run_id:run});const paused=await consumerStage(f,run,'pause');await paused.run();await f.broker({action:'resume-cutover-consumers',run_id:run});const resumed=await consumerStage(f,run,'resume',{rows:paused.rows,api:paused.api});
  await assert.rejects(resumed.run(),/TRAFFIC_STATE/);resumed.api.traffic='running';resumed.api.ready=false;await assert.rejects(resumed.run(),/NOT_READY/);resumed.api.ready=true;resumed.api.hyperdrive='other';await assert.rejects(resumed.run(),/HANDOFF_REQUIRED/);assert.equal(resumed.updates,0);
 }finally{await f.close();}
});
test('DB mutation marker rejects consumer restore, generic recovery and redrive',async()=>{
 const {f,run}=await preparedControl();try{
  await f.broker({action:'pause-cutover-consumers',run_id:run});const row=await f.get('run#'+run);await f.put({...row,database_mutations_started:{BOOL:true}});f.states.set(executionArn(MACHINE,'db-'+run),'FAILED');
  for(const action of ['resume-cutover-consumers','recover-cutover-hold','retry-cutover-consumers','release-cutover-hold','inspect-cutover-activity','retry-cutover-activity'])await assert.rejects(f.broker({action,run_id:run}),/MUTATION_RECOVERY/);assert.equal(f.calls.filter(c=>c.command==='RedriveExecution').length,0);assert.ok(await f.get('maintenance'));
 }finally{await f.close();}
});
test('completion response loss and repeated stage execution do not change the original admission plan',async()=>{
 const {f,run}=await preparedControl();try{
  await f.broker({action:'pause-cutover-consumers',run_id:run});const stage=await consumerStage(f,run,'pause',{loseCompletion:true});assert.equal((await stage.run()).consumers_paused,true);const updates=stage.updates;assert.equal((await stage.run()).consumers_paused,true);assert.equal(stage.updates,updates);
 }finally{await f.close();}
});
test('consumer mutation controls are disabled unless the separate capability is enabled',async()=>{
 const f=await fixture();try{const {run_id:run}=await f.start();for(const action of ['pause-cutover-consumers','resume-cutover-consumers','retry-cutover-consumers','inspect-cutover-activity','retry-cutover-activity'])await assert.rejects(f.broker({action,run_id:run}),/CONTROL_DISABLED/);assert.equal((await f.get('run#'+run)).cutover_phase.S,'holding');}finally{await f.close();}
});
test('redrive checks older build pages before accepting that no build remains active',async()=>{
 let includeOlder=false;
 const f=await fixture({consumerControlEnabled:true,listBuilds:input=>!includeOlder?{ids:[]}:input.nextToken?{ids:['active-late']}:{ids:['finished'],nextToken:'older'}});
 try{
  const {run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});await preparation(f,run).run();await f.broker({action:'pause-cutover-consumers',run_id:run});f.states.set(executionArn(MACHINE,'db-'+run),'FAILED');includeOlder=true;
  await assert.rejects(f.broker({action:'retry-cutover-consumers',run_id:run}),/PREVIOUS_BUILD_STILL_RUNNING/);assert.equal(f.calls.filter(c=>c.command==='RedriveExecution').length,0);assert.ok(f.calls.some(c=>c.command==='ListBuildsForProject'&&c.value.nextToken==='older'));assert.ok(await f.get('maintenance'));
 }finally{await f.close();}
});
test('an old or different execution definition cannot enter consumer mutation phases',async()=>{
 for(const boundDefinition of [{StartAt:'Old',States:{Old:{Type:'Succeed'}}},table=>{const spec=definition({table,projects:{}});spec.States.ReleaseCutoverHold.Parameters.TransactItems[0].ConditionCheck.ConditionExpression='attribute_exists(pk)';return spec;}]){
  const f=await fixture({consumerControlEnabled:true,boundDefinition});
  try{const {run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});await preparation(f,run).run();await assert.rejects(f.broker({action:'pause-cutover-consumers',run_id:run}),/DEFINITION_MISMATCH/);assert.equal((await f.get('run#'+run)).cutover_phase.S,'holding');assert.equal(f.calls.filter(c=>c.command==='RedriveExecution').length,0);}finally{await f.close();}
 }
});

const {createOwnedDeploymentFreeze}=require('./cutover-owned-deployment-freeze.cjs');
function deploymentStage(f,run,{failAt=Infinity,restoreSafe=true,loseIntent=false,loseCompletion=false}={}){
 const rows=[{id:252628432,path:'.github/workflows/cd.yml',state:'active'},{id:403417588,path:'.github/workflows/db-maintenance-cd.yml',state:'disabled_manually'}],writes=[];let safety=restoreSafe,lostIntent=false,lostCompletion=false;
 const request=async(method,path)=>{
  const match=/workflows\/(\d+)(.*)$/.exec(path);assert.ok(match);const row=rows.find(r=>r.id===Number(match[1]));assert.ok(row);
  if(method==='GET')return match[2]?{total_count:0,workflow_runs:[]}:{...row};
  assert.equal(method,'PUT');writes.push(path);if(writes.length===failAt)throw Error('synthetic write failure');row.state=path.endsWith('/disable')?'disabled_manually':'active';return null;
 };
 const aws=async(service,command,value)=>{
  const result=await f.aws(service,command,value);
  const expression=value.TransactItems?.[0]?.Update?.UpdateExpression??'';
  if(command==='TransactWriteItems'&&((loseIntent&&!lostIntent&&expression.includes('SET deployment_freeze_plan'))||(loseCompletion&&!lostCompletion&&expression.includes('SET deployment_admission_restored')))){if(expression.includes('SET deployment_freeze_plan'))lostIntent=true;else lostCompletion=true;throw Error('lost DDB response');}
  return result;
 };
 const operate=createOwnedDeploymentFreeze({aws,request,table:f.table,machine:MACHINE,expectedDefinitionHash:require('../../infra/db-maintenance/runtime/cutover-hold.cjs').definitionHash(definition({table:f.table,projects:{}})),enabled:true,assertRestoreSafe:async()=>{if(!safety)throw Error('unverified handoff');}});
 return{rows,writes,request,set safety(v){safety=v;},run:action=>operate({action,run,source:SHA})};
}
test('owned deployment freeze blocks release/recovery and the atomic SFN release until verified restore',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start(),stage=deploymentStage(f,run);assert.equal((await stage.run('freeze')).admissionFrozen,true);const row=await f.get('run#'+run);assert.equal(row.deployment_admission_restored.BOOL,false);
  await assert.rejects(f.broker({action:'release-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);
  await f.put({...row,release_requested:{BOOL:true}});await assert.rejects(f.finish(run),/Transaction cancelled/);assert.ok(await f.get('maintenance'));await f.put(row);
  f.states.set(row.execution_arn.S,'FAILED');await assert.rejects(f.broker({action:'recover-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);await assert.rejects(stage.run('restore'),/EXECUTION_REQUIRED/);f.states.set(row.execution_arn.S,'RUNNING');
  assert.equal((await stage.run('restore')).originalAdmissionRestored,true);assert.equal((await stage.run('restore')).originalAdmissionRestored,true);assert.equal(stage.writes.length,2);assert.equal(stage.rows[1].state,'disabled_manually');
  await assert.rejects(stage.run('freeze'),/ALREADY_RESTORED/);await f.broker({action:'release-cutover-hold',run_id:run});await f.finish(run);assert.equal(await f.get('maintenance'),undefined);
 }finally{await f.close();}
});
test('unverified deployment handoff, paused consumers and database mutations cannot restore automation',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start(),stage=deploymentStage(f,run,{restoreSafe:false});await stage.run('freeze');await assert.rejects(stage.run('restore'),/unverified handoff/);assert.equal(stage.writes.length,1);stage.safety=true;
  const row=await f.get('run#'+run);await f.put({...row,consumer_admission_restored:{BOOL:false}});await assert.rejects(stage.run('restore'),/CONSUMER_RESTORATION/);await f.put({...row,database_mutations_started:{BOOL:true}});await assert.rejects(stage.run('restore'),/OWNERSHIP/);assert.equal(stage.writes.length,1);assert.equal((await f.get('run#'+run)).deployment_admission_restored.BOOL,false);
 }finally{await f.close();}
});
test('lost intent/completion responses preserve the immutable original plan and reconcile by readback',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start(),stage=deploymentStage(f,run,{loseIntent:true,loseCompletion:true});await stage.run('freeze');const before=await f.get('run#'+run);await stage.run('freeze');assert.equal((await f.get('run#'+run)).deployment_freeze_plan.S,before.deployment_freeze_plan.S);assert.equal(stage.writes.length,1);
  await stage.run('restore');assert.equal((await f.get('run#'+run)).deployment_admission_restored.BOOL,true);assert.equal(stage.writes.length,2);
 }finally{await f.close();}
});
test('failed workflow write retains the owned hold and refuses automatic release',async()=>{
 const f=await fixture();try{
  const {run_id:run}=await f.start(),stage=deploymentStage(f,run,{failAt:1});await assert.rejects(stage.run('freeze'),/synthetic write/);const row=await f.get('run#'+run);assert.equal(row.deployment_admission_restored.BOOL,false);assert.ok(await f.get('maintenance'));await assert.rejects(f.broker({action:'release-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);
 }finally{await f.close();}
});
test('old execution definition cannot persist an intent or disable workflows',async()=>{
 const old=structuredClone(definition({table:'ignored',projects:{}}));old.States.ReleaseCutoverHold.Parameters.TransactItems[0].ConditionCheck.ConditionExpression='#phase = :phase AND release_requested = :requested';
 const f=await fixture({boundDefinition:table=>({...old,States:{...old.States,ReadCutoverHold:{...old.States.ReadCutoverHold,Parameters:{...old.States.ReadCutoverHold.Parameters,TableName:table}}}})});try{
  const {run_id:run}=await f.start(),stage=deploymentStage(f,run);await assert.rejects(stage.run('freeze'),/EXECUTION_REQUIRED/);assert.equal(stage.writes.length,0);assert.equal((await f.get('run#'+run)).deployment_freeze_plan,undefined);
 }finally{await f.close();}
});
test('atomic SFN release independently refuses DB or consumer mutation markers',async()=>{
 for(const marker of [{database_mutations_started:{BOOL:true}},{consumer_admission_restored:{BOOL:false}}]){
  const f=await fixture();try{const {run_id:run}=await f.start(),row=await f.get('run#'+run);await f.put({...row,...marker,release_requested:{BOOL:true}});await assert.rejects(f.finish(run),/Transaction cancelled/);assert.ok(await f.get('maintenance'));}finally{await f.close();}
 }
});

const {createOwnedApiTraffic}=require('./cutover-owned-api-traffic.cjs');
function ownedApiStage(f,run,deployment,{failProbe=false,loseIntent=false,loseCompletion=false}={}){
 const api={traffic:undefined,hyperdrive:'a'.repeat(32),ready:true};let patchCount=0,probeFails=failProbe,safe=true,lostIntent=false,lostCompletion=false;
 const request=async(method,path,body)=>{
  const version='11111111-2222-4333-8444-555555555555';
  if(method==='GET'){
   if(path.endsWith('/deployments'))return{deployments:[{id:'11111111-2222-4333-8444-666666666666',versions:[{version_id:version,percentage:100}]}]};if(path.endsWith('/versions?per_page=1'))return{items:[{id:version}]};assert.ok(path.endsWith('/settings'));return{bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'HYPERDRIVE',type:'hyperdrive',id:api.hyperdrive},...(api.traffic===undefined?[]:[{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:api.traffic}])]};
  }
  assert.equal(method,'PATCH');patchCount++;api.traffic=body.bindings.find(b=>b.name==='MIGRATION_TRAFFIC_STATE')?.text;return{};
 };
 const aws=async(service,command,value)=>{const result=await f.aws(service,command,value),expression=value.TransactItems?.[0]?.Update?.UpdateExpression??'';
  if(command==='TransactWriteItems'&&((loseIntent&&!lostIntent&&expression.includes('SET api_traffic_plan'))||(loseCompletion&&!lostCompletion&&expression.includes('SET api_admission_restored')))){if(expression.includes('SET api_traffic_plan'))lostIntent=true;else lostCompletion=true;throw Error('lost DDB response');}return result;};
 const operate=createOwnedApiTraffic({aws,request,table:f.table,machine:MACHINE,expectedDefinitionHash:require('../../infra/db-maintenance/runtime/cutover-hold.cjs').definitionHash(definition({table:f.table,projects:{}})),enabled:true,assertDeploymentsFrozen:async()=>{if(deployment.rows.some(r=>r.state!=='disabled_manually'))throw Error('deployment admission reopened');},assertRestoreSafe:async()=>{if(!safe)throw Error('unverified API handoff');},verifyTraffic:async paused=>{if(probeFails)throw Error('application did not pause');assert.equal(api.traffic==='paused',paused);return paused?{applicationPauseVerified:true,inFlightDrainProven:false}:{applicationReadyVerified:true,inFlightDrainProven:false};}});
 return{api,request,get patches(){return patchCount;},set probeFails(v){probeFails=v;},set safe(v){safe=v;},run:action=>operate({action,run,source:SHA})};
}
test('owned deployment freeze, API pause, consumer pause and pre-write abort compose without early release',async()=>{
 const f=await fixture({consumerControlEnabled:true});try{
  const{run_id:run}=await f.start(),deployment=deploymentStage(f,run);await deployment.run('freeze');const stage=ownedApiStage(f,run,deployment);await stage.run('pause');assert.equal((await f.get('run#'+run)).api_pause_verified.BOOL,true);
  await assert.rejects(deployment.run('restore'),/API_RESTORATION/);await assert.rejects(f.broker({action:'release-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);
  await f.broker({action:'prepare-cutover-consumers',run_id:run});await preparation(f,run,{disabledAccount:true}).run();await f.broker({action:'pause-cutover-consumers',run_id:run});const paused=await consumerStage(f,run,'pause',{api:stage.api});await paused.run();
  await stage.run('restore');await f.broker({action:'resume-cutover-consumers',run_id:run});const resumed=await consumerStage(f,run,'resume',{api:stage.api,rows:paused.rows});await resumed.run();await deployment.run('restore');await f.broker({action:'release-cutover-hold',run_id:run});await f.finish(run);assert.equal(stage.patches,2);assert.equal(await f.get('maintenance'),undefined);
 }finally{await f.close();}
});
test('metadata pause without verified real application response cannot unlock or pause consumers',async()=>{
 const f=await fixture({consumerControlEnabled:true});try{
  const{run_id:run}=await f.start(),deployment=deploymentStage(f,run);await deployment.run('freeze');const stage=ownedApiStage(f,run,deployment,{failProbe:true});await assert.rejects(stage.run('pause'),/did not pause/);let row=await f.get('run#'+run);assert.equal(row.api_admission_restored.BOOL,false);assert.equal(row.api_pause_verified.BOOL,false);
  await f.broker({action:'prepare-cutover-consumers',run_id:run});await preparation(f,run).run();await assert.rejects(f.broker({action:'pause-cutover-consumers',run_id:run}),/VERIFIED_API_TRAFFIC/);row=await f.get('run#'+run);assert.equal(row.cutover_phase.S,'holding');await f.put({...row,cutover_phase:{S:'consumers-pausing'},consumer_action_id:{S:'c'.repeat(32)}});const consumers=await consumerStage(f,run,'pause',{api:stage.api});await assert.rejects(consumers.run(),/VERIFIED_API_TRAFFIC/);assert.equal(consumers.updates,0);
  row=await f.get('run#'+run);await f.put({...row,cutover_phase:{S:'holding'},release_requested:{BOOL:true},deployment_admission_restored:{BOOL:true},consumer_admission_restored:{BOOL:true}});await assert.rejects(f.finish(run),/Transaction cancelled/);assert.ok(await f.get('maintenance'));const isolated=await f.get('run#'+run);await f.put({...isolated,release_requested:{BOOL:false}});await assert.rejects(f.broker({action:'release-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);f.states.set(isolated.execution_arn.S,'FAILED');await assert.rejects(f.broker({action:'recover-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);
 }finally{await f.close();}
});
test('lost API intent and completion responses reuse the original plan and preserve exactly two metadata writes',async()=>{
 const f=await fixture();try{const{run_id:run}=await f.start(),deployment=deploymentStage(f,run);await deployment.run('freeze');const stage=ownedApiStage(f,run,deployment,{loseIntent:true,loseCompletion:true});await stage.run('pause');const original=(await f.get('run#'+run)).api_traffic_plan.S;await stage.run('pause');stage.safe=false;await assert.rejects(stage.run('restore'),/unverified/);stage.safe=true;await stage.run('restore');await stage.run('restore');assert.equal(stage.patches,2);assert.equal((await f.get('run#'+run)).api_traffic_plan.S,original);await assert.rejects(stage.run('pause'),/ALREADY_RESTORED/);}finally{await f.close();}
});
test('reopened deployment admission and DB mutation refuse API operations while exclusion remains held',async()=>{
 const f=await fixture();try{const{run_id:run}=await f.start(),deployment=deploymentStage(f,run);await deployment.run('freeze');const stage=ownedApiStage(f,run,deployment);deployment.rows[0].state='active';await assert.rejects(stage.run('pause'),/admission reopened/);assert.equal(stage.patches,0);deployment.rows[0].state='disabled_manually';await stage.run('pause');const row=await f.get('run#'+run);await f.put({...row,database_mutations_started:{BOOL:true}});await assert.rejects(stage.run('restore'),/OWNERSHIP/);assert.equal(stage.patches,1);await assert.rejects(f.broker({action:'recover-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);}finally{await f.close();}
});

async function pausedActivityFixture(){
 const f=await fixture({consumerControlEnabled:true});const{run_id:run}=await f.start(),deployment=deploymentStage(f,run);await deployment.run('freeze');const api=ownedApiStage(f,run,deployment);await api.run('pause');await f.broker({action:'prepare-cutover-consumers',run_id:run});await preparation(f,run,{disabledAccount:true}).run();await f.broker({action:'pause-cutover-consumers',run_id:run});const consumers=await consumerStage(f,run,'pause',{api:api.api});await consumers.run();return{f,run,deployment,api,consumers};
}
async function heldActivityStage(ctx,{failChild=false,loseCompletion=false,activeJobs=0,contradictory=false,mutatePlan=()=>{},beforeActivityReturn=async()=>{},failAfterFence=false}={}){
 const{f,run,api,consumers}=ctx,row=await f.get('run#'+run),{writeFile,access}=require('node:fs/promises');let fail=failChild,childCalls=0,lost=false,lastDirectory;
 const role={oid:42,name:'videoq_api_test',can_login:true,superuser:false,create_db:false,create_role:false,replication:false,bypass_rls:false,inherit:true,connection_limit:-1,valid_until:null};
 const plan={version:1,operationId:randomUUID(),target:{purpose:'production',host:'ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech',databaseName:'neondb',rolePrefix:'videoq_'},roles:[role],memberships:[],catalogSha256:require('node:crypto').createHash('sha256').update(JSON.stringify({roles:[{...role,can_login:null}],memberships:[]})).digest('hex')};
 mutatePlan(plan);
 const report={version:1,databaseName:'neondb',observedAt:new Date().toISOString(),readOnly:true,snapshotScope:'single-read-only-statement',counts:{jobLeasesActive:activeJobs,jobLeasesExpired:0,jobLeasesInvalid:0,chatLeasesActive:0,chatLeasesExpired:0,chatLeasesInvalid:0,answerAttemptsStarted:0,videosProcessing:0,transcriptionRunsIncomplete:0,visualRunsProcessing:0},activeLeasesObserved:activeJobs>0,requiresReconciliation:false,inFlightDrainProven:false};
 if(contradictory)report.activeLeasesObserved=!report.activeLeasesObserved;
 const rename=value=>Array.isArray(value)?value.map(rename):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='TableName'?f.table:rename(v)])):value;
 const aws=async(service,command,value)=>{if(service==='lambda'){assert.equal(command,'list-event-source-mappings');return{EventSourceMappings:consumers.rows.filter(r=>r.FunctionArn.endsWith(':'+value.FunctionName))};}assert.equal(service,'dynamodb');if(command==='get-item')return client.send(new sdk.GetItemCommand(rename(value)));assert.equal(command,'transact-write-items');const result=await client.send(new sdk.TransactWriteItemsCommand(rename(value)));if(loseCompletion&&!lost){lost=true;throw Error('lost completion response');}return result;};
 const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C',VIDEOQ_CUTOVER_CONSUMER_CONTROL:'true',MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:SHA,MAINTENANCE_ACTIVITY_ACTION_ID:row.activity_action_id.S,MAINTENANCE_KIND:HOLD_KIND,MAINTENANCE_STAGE:'cutover-activity-audit',MAINTENANCE_TABLE:'videoq-db-maintenance-prod',CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:11111111-2222-4333-8444-555555555555',AWS_ACCESS_KEY_ID:'parent-only',AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:'/parent',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'parent-only',NODE_OPTIONS:'parent-only',PGPASSWORD:'parent-only'};
 const fetcher=async(url,options)=>{if(url.startsWith('https://api.cloudflare.com/'))return Response.json({success:true,result:{bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'HYPERDRIVE',type:'hyperdrive',id:api.api.hyperdrive},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:api.api.traffic}]}});assert.equal(options.headers,undefined);if(url.endsWith('/health'))return Response.json({data:{status:'ok'}});return Response.json({error:{code:'MIGRATION_PAUSED'}},{status:503,headers:{'retry-after':'60','cache-control':'no-store'}});};
 const readParameter=async name=>{if(name==='/videoq/security/prod/cutover-control')return{CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'synthetic-cutover-token-0123456789'};assert.equal(name,'/videoq/security/prod/db-admin');return{DATABASE_URL:'postgresql://admin:synthetic-child-only@ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full'};};
 const child=async(command,args,options)=>{childCalls++;assert.equal(command,process.execPath);const mode=args[args.indexOf('--mode')+1],mutate=['install','release'].includes(mode);assert.equal(options.env.PGOPTIONS,'-c default_transaction_read_only='+(mutate?'off':'on')+' -c search_path=pg_catalog');assert.ok(Object.keys(options.env).every(k=>['PATH','HOME','TMPDIR','LANG','VIDEOQ_FENCE_ADMIN_DATABASE_URL','PGOPTIONS',...(mutate?['VIDEOQ_MIGRATION_UPSTREAM_STOPPED']:[])].includes(k)));if(mutate){assert.equal(options.env.VIDEOQ_MIGRATION_UPSTREAM_STOPPED,'1');assert.equal(args[args.indexOf('--confirm-database')+1],'neondb');}assert.ok(options.env.VIDEOQ_FENCE_ADMIN_DATABASE_URL.includes('synthetic-child-only'));assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);const state=args[args.indexOf('--state')+1];lastDirectory=require('node:path').dirname(state);if(fail&&!failAfterFence)throw Error('synthetic child failure');if(args[args.indexOf('--mode')+1]==='prepare'){await writeFile(state,JSON.stringify(plan),{mode:0o600});return{stdout:JSON.stringify({prepared:true,purpose:'production',roles:1,writeFenceInstalled:false})};}if(['install','release','inspect'].includes(mode)){
 const saved=JSON.parse(await require('node:fs/promises').readFile(state,'utf8'));assert.equal(saved.roles[0].can_login,true);assert.equal(saved.operationId,JSON.parse((await f.get('run#'+run)).postgres_fence_original_plan.S).operationId);
 if(mode==='install')ctx.fenceState='fenced';if(mode==='release')ctx.fenceState='open';if(mutate&&failAfterFence&&fail){throw Error('lost fence mutation response');}
 return{stdout:JSON.stringify({state:ctx.fenceState??'open',writerLogins:1,enabledWriterLogins:ctx.fenceState==='fenced'?0:1,writerSessions:0,otherDatabaseSessions:0,unknownSessions:0,preparedTransactions:0,purpose:'production',upstreamStoppedByThisCommand:false})};
 }await beforeActivityReturn();return{stdout:JSON.stringify({activity:report,purpose:'production',upstreamStoppedByThisCommand:false})};};
 const {runHeldPostgresActivity}=await import('./cutover-postgres-activity.mjs');return{env,get childCalls(){return childCalls;},set fail(v){fail=v;},run:()=>runHeldPostgresActivity({env,aws,readParameter,fetcher,run:child,root:operatorRoot}),async temporaryDirectoryRemoved(){await assert.rejects(access(lastDirectory));}};
}
test('owned held activity persists only validated observations and does not claim zero active work or release exclusion',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{await f.broker({action:'inspect-cutover-activity',run_id:run});const stage=await heldActivityStage(ctx,{activeJobs:1});await stage.run();await stage.temporaryDirectoryRemoved();const row=await f.get('run#'+run);assert.equal(row.cutover_phase.S,'consumers-paused');assert.equal(row.activity_observed.BOOL,true);const report=JSON.parse(row.activity_report.S);assert.equal(report.counts.jobLeasesActive,1);assert.equal(report.inFlightDrainProven,false);assert.equal((await f.broker({action:'status',run_id:run})).activity_observed,true);assert.ok(await f.get('maintenance'));await assert.rejects(f.broker({action:'release-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);await stage.run();assert.equal(stage.childCalls,2);}finally{await f.close();}
});
test('failed held activity retains exclusion and explicitly redrives the same execution/command',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{await f.broker({action:'inspect-cutover-activity',run_id:run});const before=await f.get('run#'+run),stage=await heldActivityStage(ctx,{failChild:true});await assert.rejects(stage.run(),/synthetic child/);await stage.temporaryDirectoryRemoved();f.states.set(before.execution_arn.S,'FAILED');await assert.rejects(f.broker({action:'recover-cutover-hold',run_id:run}),/MUTATION_RECOVERY/);assert.equal((await f.broker({action:'retry-cutover-activity',run_id:run})).activity_retry_accepted,true);assert.equal(f.calls.filter(c=>c.command==='StartExecution').length,1);assert.equal((await f.get('run#'+run)).activity_action_id.S,before.activity_action_id.S);stage.fail=false;await stage.run();assert.equal((await f.broker({action:'status',run_id:run})).activity_observed,true);}finally{await f.close();}
});
test('held activity completion response loss is read back and a stale command cannot replace a fresh observation',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{await f.broker({action:'inspect-cutover-activity',run_id:run});const stage=await heldActivityStage(ctx,{loseCompletion:true});await stage.run();await stage.run();assert.equal(stage.childCalls,2);const valid=await f.get('run#'+run);await f.put({...valid,activity_report_sha256:{S:'f'.repeat(64)}});await assert.rejects(f.broker({action:'status',run_id:run}),/INVALID_ACTIVITY_REPORT/);await f.put(valid);await f.broker({action:'inspect-cutover-activity',run_id:run});await assert.rejects(stage.run(),/OWNERSHIP/);assert.equal(stage.childCalls,2);assert.equal((await f.get('run#'+run)).activity_observed.BOOL,false);}finally{await f.close();}
});
test('API or mapping admission drift refuses held activity before DB child execution',async()=>{
 for(const drift of [ctx=>ctx.api.api.traffic='running',ctx=>ctx.consumers.rows[0].State='Enabled']){const ctx=await pausedActivityFixture(),{f,run}=ctx;try{await f.broker({action:'inspect-cutover-activity',run_id:run});const stage=await heldActivityStage(ctx);drift(ctx);await assert.rejects(stage.run(),/NOT_PAUSED/);assert.equal(stage.childCalls,0);assert.ok(await f.get('maintenance'));}finally{await f.close();}}
});

test('contradictory child activity flags cannot become a completed observation',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{await f.broker({action:'inspect-cutover-activity',run_id:run});const stage=await heldActivityStage(ctx,{activeJobs:1,contradictory:true});await assert.rejects(stage.run(),/Inconsistent PostgreSQL activity/);await stage.temporaryDirectoryRemoved();const row=await f.get('run#'+run);assert.equal(row.activity_observed.BOOL,false);assert.equal(row.cutover_phase.S,'activity-auditing');assert.ok(await f.get('maintenance'));}finally{await f.close();}
});

test('published preparation cannot start a new stage until its native TaskSucceeded is recorded',async()=>{
 const f=await fixture({consumerControlEnabled:true});try{const{run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});await preparation(f,run).run();f.active=true;assert.equal((await f.broker({action:'status',run_id:run})).consumer_prepared,undefined);await assert.rejects(f.broker({action:'pause-cutover-consumers',run_id:run}),/STILL_COMPLETING/);assert.equal((await f.get('run#'+run)).cutover_phase.S,'holding');f.active=false;assert.equal((await f.broker({action:'status',run_id:run})).consumer_prepared,true);}finally{await f.close();}
});
test('published paused activity cannot restore API or advance another command before native completion',async()=>{
 const ctx=await pausedActivityFixture(),{f,run,api}=ctx;try{await f.broker({action:'inspect-cutover-activity',run_id:run});await(await heldActivityStage(ctx)).run();f.active=true;const status=await f.broker({action:'status',run_id:run});assert.equal(status.activity_observed,undefined);assert.equal(status.consumers_paused,undefined);await assert.rejects(api.run('restore'),/STILL_COMPLETING/);await assert.rejects(f.broker({action:'inspect-cutover-activity',run_id:run}),/STILL_COMPLETING/);f.active=false;assert.equal((await f.broker({action:'status',run_id:run})).activity_observed,true);await api.run('restore');}finally{await f.close();}
});

test('a redriven committed activity acknowledges a new build without regenerating its observation',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{await f.broker({action:'inspect-cutover-activity',run_id:run});const stage=await heldActivityStage(ctx);await stage.run();const before=await f.get('run#'+run);stage.env.CODEBUILD_BUILD_ARN=stage.env.CODEBUILD_BUILD_ARN.replace('555555555555','777777777777');await stage.run();const after=await f.get('run#'+run);assert.equal(after.cutover_last_build_arn.S,stage.env.CODEBUILD_BUILD_ARN);assert.equal(after.activity_report.S,before.activity_report.S);f.active=true;assert.equal((await f.broker({action:'status',run_id:run})).activity_observed,undefined);f.active=false;assert.equal((await f.broker({action:'status',run_id:run})).activity_observed,true);assert.equal(stage.childCalls,2);}finally{await f.close();}
});


test('fresh observations preserve the original pre-fence plan and its first build/action',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{
  await f.broker({action:'inspect-cutover-activity',run_id:run});const first=await heldActivityStage(ctx,{loseCompletion:true});await first.run();const original=await f.get('run#'+run);
  await f.broker({action:'inspect-cutover-activity',run_id:run});const second=await heldActivityStage(ctx);second.env.CODEBUILD_BUILD_ARN=second.env.CODEBUILD_BUILD_ARN.replace('555555555555','888888888888');await second.run();const next=await f.get('run#'+run);
  for(const key of ['postgres_fence_original_plan','postgres_fence_original_sha256','postgres_fence_original_build_arn','postgres_fence_original_action_id'])assert.deepEqual(next[key],original[key]);
  assert.notEqual(JSON.parse(next.activity_fence_plan.S).operationId,JSON.parse(original.postgres_fence_original_plan.S).operationId);assert.notEqual(next.activity_action_id.S,next.postgres_fence_original_action_id.S);assert.equal(next.activity_build_arn.S,second.env.CODEBUILD_BUILD_ARN);assert.equal(next.database_mutations_started.BOOL,false);assert.ok(await f.get('maintenance'));
 }finally{await f.close();}
});
test('catalog drift cannot replace the original recovery plan or publish a fresh observation',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{
  await f.broker({action:'inspect-cutover-activity',run_id:run});await(await heldActivityStage(ctx)).run();const original=await f.get('run#'+run);await f.broker({action:'inspect-cutover-activity',run_id:run});const changed=await heldActivityStage(ctx,{mutatePlan:plan=>{plan.roles[0].connection_limit=12;}});await assert.rejects(changed.run(),/ORIGINAL_POSTGRES_FENCE_CATALOG_CHANGED/);assert.equal(changed.childCalls,1);await changed.temporaryDirectoryRemoved();const after=await f.get('run#'+run);assert.equal(after.postgres_fence_original_plan.S,original.postgres_fence_original_plan.S);assert.equal(after.activity_observed.BOOL,false);assert.equal(after.cutover_phase.S,'activity-auditing');assert.ok(await f.get('maintenance'));
 }finally{await f.close();}
});
test('partial or corrupt original-state records fail before any database child is run',async()=>{
 for(const corrupt of [row=>{row.postgres_fence_original_sha256={S:'a'.repeat(64)};},row=>{row.postgres_fence_original_plan={S:'{}'};row.postgres_fence_original_sha256={S:'b'.repeat(64)};}]){
  const ctx=await pausedActivityFixture(),{f,run}=ctx;try{await f.broker({action:'inspect-cutover-activity',run_id:run});const row=await f.get('run#'+run);corrupt(row);await f.put(row);const stage=await heldActivityStage(ctx);await assert.rejects(stage.run(),/INVALID_ORIGINAL_POSTGRES_FENCE_PLAN/);assert.equal(stage.childCalls,0);assert.ok(await f.get('maintenance'));}finally{await f.close();}
 }
});
test('a concurrent partial original-state write prevents atomic completion without overwriting it',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{
  await f.broker({action:'inspect-cutover-activity',run_id:run});const stage=await heldActivityStage(ctx,{beforeActivityReturn:async()=>{const row=await f.get('run#'+run);await f.put({...row,postgres_fence_original_sha256:{S:'c'.repeat(64)}});}});await assert.rejects(stage.run(),/Transaction cancelled/);const after=await f.get('run#'+run);assert.equal(after.postgres_fence_original_sha256.S,'c'.repeat(64));assert.equal(after.postgres_fence_original_plan,undefined);assert.equal(after.activity_observed.BOOL,false);assert.ok(await f.get('maintenance'));await stage.temporaryDirectoryRemoved();
 }finally{await f.close();}
});


function admissionOperator(f,run,deployment,api,{failProbe=false,cloudflare=api.request,loseBaselineResponse=false}={}){
 const {createAdmissionOperator}=require('./cutover-admission-operator.cjs');let mappings,lost=false;
 const aws=async(service,command,value)=>{if(service==='lambda'){assert.equal(command,'ListEventSourceMappings');return{EventSourceMappings:mappings.rows.filter(r=>r.FunctionArn.endsWith(':'+value.FunctionName))};}const result=await f.aws(service,command,value);if(loseBaselineResponse&&!lost&&command==='TransactWriteItems'&&value.TransactItems?.[0]?.Update?.UpdateExpression.includes('SET operator_admission_baseline')){lost=true;throw Error('lost baseline response');}return result;};
 const operate=createAdmissionOperator({aws,github:deployment.request,cloudflare,table:f.table,machine:MACHINE,expectedDefinitionHash:require('../../infra/db-maintenance/runtime/cutover-hold.cjs').definitionHash(definition({table:f.table,projects:{}})),enabled:true,verifyTraffic:async paused=>{if(failProbe)throw Error('fixture readiness failed');assert.equal(api.api.traffic==='paused',paused);return paused?{applicationPauseVerified:true,inFlightDrainProven:false}:{applicationReadyVerified:true,inFlightDrainProven:false};}});
 return{set mappings(value){mappings=value;},run:action=>operate({action,run,source:SHA})};
}
test('operator composes a verified pre-write pause and abort using actual owned DDB transactions',async()=>{
 const f=await fixture({consumerControlEnabled:true});try{
  const{run_id:run}=await f.start(),deployment=deploymentStage(f,run),api=ownedApiStage(f,run,deployment),operator=admissionOperator(f,run,deployment,api,{loseBaselineResponse:true});
  assert.equal((await operator.run('freeze-deployments')).deploymentAdmissionFrozen,true);const original=(await f.get('run#'+run)).operator_admission_baseline.S;await operator.run('freeze-deployments');assert.equal((await operator.run('pause-api')).apiPauseVerified,true);
  await f.broker({action:'prepare-cutover-consumers',run_id:run});await preparation(f,run,{disabledAccount:true}).run();await f.broker({action:'pause-cutover-consumers',run_id:run});const paused=await consumerStage(f,run,'pause',{api:api.api});await paused.run();operator.mappings=paused;
  assert.equal((await operator.run('restore-api')).apiRestored,true);await f.broker({action:'resume-cutover-consumers',run_id:run});const resumed=await consumerStage(f,run,'resume',{api:api.api,rows:paused.rows});await resumed.run();operator.mappings=resumed;
  assert.equal((await operator.run('restore-deployments')).deploymentAdmissionRestored,true);await operator.run('restore-deployments');assert.equal((await f.get('run#'+run)).operator_admission_baseline.S,original);assert.equal(api.patches,2);await f.broker({action:'release-cutover-hold',run_id:run});await f.finish(run);assert.equal(await f.get('maintenance'),undefined);
 }finally{await f.close();}
});
test('operator credential/backend preflight failure disables no deployment workflow',async()=>{
 const f=await fixture();try{const{run_id:run}=await f.start(),deployment=deploymentStage(f,run),api=ownedApiStage(f,run,deployment),operator=admissionOperator(f,run,deployment,api,{cloudflare:async()=>{throw Error('fixture cloud unavailable');}});await assert.rejects(operator.run('freeze-deployments'),/cloud unavailable/);assert.equal(deployment.writes.length,0);assert.equal((await f.get('run#'+run)).deployment_freeze_plan,undefined);}finally{await f.close();}
});
test('operator refuses backend drift or a fence intent without restoring API or deployment admission',async()=>{
 const f=await fixture();try{
  const{run_id:run}=await f.start(),deployment=deploymentStage(f,run),api=ownedApiStage(f,run,deployment),operator=admissionOperator(f,run,deployment,api);await operator.run('freeze-deployments');await operator.run('pause-api');const original=api.api.hyperdrive;api.api.hyperdrive='different-backend';await assert.rejects(operator.run('restore-api'),/BACKEND_CHANGED/);assert.equal(api.patches,1);api.api.hyperdrive=original;const row=await f.get('run#'+run);await f.put({...row,postgres_fence_install_intent:{S:'unfinished'}});await assert.rejects(operator.run('restore-api'),/FENCE_HANDOFF/);await assert.rejects(operator.run('restore-deployments'),/FENCE_HANDOFF/);assert.equal(api.patches,1);assert.ok(await f.get('maintenance'));
 }finally{await f.close();}
});

test('failed first workflow write preserves the backend baseline for an explicit pre-write abort',async()=>{
 const f=await fixture();try{const{run_id:run}=await f.start(),deployment=deploymentStage(f,run,{failAt:1}),api=ownedApiStage(f,run,deployment),operator=admissionOperator(f,run,deployment,api);await assert.rejects(operator.run('freeze-deployments'),/synthetic write failure/);assert.ok((await f.get('run#'+run)).operator_admission_baseline);assert.equal((await operator.run('restore-deployments')).deploymentAdmissionRestored,true);assert.equal(api.patches,0);await f.broker({action:'release-cutover-hold',run_id:run});await f.finish(run);assert.equal(await f.get('maintenance'),undefined);}finally{await f.close();}
});


test('held fence install/release preserves original LOGIN baseline, blocks restoration, and requires native completion',async()=>{
 const ctx=await pausedActivityFixture(),{f,run,api}=ctx;try{
  await f.broker({action:'inspect-cutover-activity',run_id:run});await(await heldActivityStage(ctx)).run();const original=(await f.get('run#'+run)).postgres_fence_original_plan.S;
  await f.broker({action:'install-cutover-fence',run_id:run});const install=await heldActivityStage(ctx);await install.run();await install.temporaryDirectoryRemoved();let row=await f.get('run#'+run);assert.equal(row.postgres_fence_state.S,'fenced');assert.equal(ctx.fenceState,'fenced');assert.equal(row.database_mutations_started.BOOL,false);assert.equal(row.postgres_fence_original_plan.S,original);
  await assert.rejects(api.run('restore'),/FENCE_HANDOFF/);await assert.rejects(f.broker({action:'resume-cutover-consumers',run_id:run}),/FENCE_HANDOFF/);
  f.active=true;assert.equal((await f.broker({action:'status',run_id:run})).fence_installed,undefined);await assert.rejects(f.broker({action:'release-cutover-fence',run_id:run}),/STILL_COMPLETING/);f.active=false;
  assert.equal((await f.broker({action:'status',run_id:run})).fence_installed,true);await f.broker({action:'release-cutover-fence',run_id:run});const release=await heldActivityStage(ctx);await release.run();row=await f.get('run#'+run);assert.equal(row.postgres_fence_state.S,'released');assert.equal(ctx.fenceState,'open');assert.equal(row.postgres_fence_original_plan.S,original);assert.equal((await f.broker({action:'status',run_id:run})).fence_released,true);
  await api.run('restore');await f.broker({action:'resume-cutover-consumers',run_id:run});await(await consumerStage(f,run,'resume',{api:api.api,rows:ctx.consumers.rows})).run();await ctx.deployment.run('restore');await f.broker({action:'release-cutover-hold',run_id:run});await f.finish(run);assert.equal(await f.get('maintenance'),undefined);
 }finally{await f.close();}
});
test('failed fence mutation leaves durable intent and redrives the same operation without restoring admission',async()=>{
 const ctx=await pausedActivityFixture(),{f,run,api}=ctx;try{
  await f.broker({action:'inspect-cutover-activity',run_id:run});await(await heldActivityStage(ctx)).run();await f.broker({action:'install-cutover-fence',run_id:run});const stage=await heldActivityStage(ctx,{failChild:true,failAfterFence:true});await assert.rejects(stage.run(),/lost fence mutation response/);let row=await f.get('run#'+run);assert.equal(row.postgres_fence_state.S,'installing');assert.equal(ctx.fenceState,'fenced');assert.equal(row.cutover_phase.S,'activity-auditing');await assert.rejects(api.run('restore'));assert.ok(await f.get('maintenance'));
  f.states.set(row.execution_arn.S,'FAILED');await f.broker({action:'retry-cutover-activity',run_id:run});stage.fail=false;await stage.run();row=await f.get('run#'+run);assert.equal(row.postgres_fence_state.S,'fenced');assert.equal(f.calls.filter(c=>c.command==='StartExecution').length,1);
  stage.env.CODEBUILD_BUILD_ARN=stage.env.CODEBUILD_BUILD_ARN.replace('555555555555','777777777777');await stage.run();await stage.run();assert.equal((await f.get('run#'+run)).cutover_last_build_arn.S,stage.env.CODEBUILD_BUILD_ARN);
 }finally{await f.close();}
});
test('remaining business activity refuses fence intent before any LOGIN change',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{await f.broker({action:'inspect-cutover-activity',run_id:run});await(await heldActivityStage(ctx)).run();await f.broker({action:'install-cutover-fence',run_id:run});const stage=await heldActivityStage(ctx,{activeJobs:1});assert.equal((await stage.run()).fence_install_refused,true);assert.equal((await f.broker({action:'status',run_id:run})).fence_install_refused,true);assert.equal((await f.get('run#'+run)).cutover_phase.S,'consumers-paused');assert.equal((await f.get('run#'+run)).postgres_fence_state,undefined);assert.equal(ctx.fenceState,undefined);await stage.temporaryDirectoryRemoved();assert.ok(await f.get('maintenance'));}finally{await f.close();}
});

test('explicit release after a lost install response redrives the same action and restores only original logins',async()=>{
 const ctx=await pausedActivityFixture(),{f,run}=ctx;try{
  await f.broker({action:'inspect-cutover-activity',run_id:run});await(await heldActivityStage(ctx)).run();await f.broker({action:'install-cutover-fence',run_id:run});const install=await heldActivityStage(ctx,{failChild:true,failAfterFence:true});await assert.rejects(install.run());const before=await f.get('run#'+run);f.states.set(before.execution_arn.S,'FAILED');
  f.active=true;await assert.rejects(f.broker({action:'release-cutover-fence',run_id:run}),/STILL_RUNNING/);f.active=false;await f.broker({action:'release-cutover-fence',run_id:run});const release=await heldActivityStage(ctx);await release.run();const after=await f.get('run#'+run);assert.equal(after.postgres_fence_state.S,'released');assert.equal(ctx.fenceState,'open');assert.equal(after.activity_action_id.S,before.activity_action_id.S);assert.equal(after.postgres_fence_original_plan.S,before.postgres_fence_original_plan.S);assert.equal(f.calls.filter(c=>c.command==='StartExecution').length,1);assert.ok(await f.get('maintenance'));
 }finally{await f.close();}
});
