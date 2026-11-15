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
let client;
before(async()=>{
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
 try{const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.Config.Labels['videoq-purpose'],'cutover-hold-ddb-fixture');await docker(['rm','--force','--volumes',name]);}
 catch(error){if(!String(error.stderr||'').includes('No such object'))throw error;}
}, {timeout:30000});
async function fixture({consumerControlEnabled=false,listBuilds}={}){
 const table='videoq_hold_'+randomUUID().replaceAll('-','');
 await client.send(new sdk.CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}]}));
 const states=new Map(),calls=[],redrives=new Map();let active=false,describe;
 const aws=async(service,command,value)=>{
  calls.push({service,command,value});
  if(service==='ddb')return client.send(new sdk[command+'Command'](value));
  if(service==='codebuild')return command==='ListBuildsForProject'?(listBuilds?listBuilds(value):{ids:active?['owned-test-build']:[]}):{builds:value.ids.map(id=>({buildComplete:!active&&id!=='active-late'}))};
  if(service==='sfn'&&command==='RedriveExecution'){redrives.set(value.executionArn,(redrives.get(value.executionArn)??0)+1);states.set(value.executionArn,'RUNNING');return {}; }
  if(service==='sfn'&&command==='StartExecution'){states.set(executionArn(MACHINE,value.name),'RUNNING');return {};}
  if(service==='sfn'&&command==='DescribeExecution'){
   const status=describe?describe(value.executionArn):states.get(value.executionArn);
   if(!status)throw Object.assign(Error('missing test execution'),{name:'ExecutionDoesNotExist'});return {status,redriveStatus:'REDRIVABLE',redriveCount:redrives.get(value.executionArn)??0};
  }
  throw Error('Unexpected test AWS operation');
 };
 const broker=createBroker(aws,{table,machine:MACHINE,projects:['rotation','migration'],consumerControlEnabled,allowedKinds:['rotate','rollback','audit','migration','backup','smoke','deploy',HOLD_KIND]},async()=>SHA);
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
 return {table,broker,get,put,start,calls,states,set active(v){active=v;},set describe(v){describe=v;},async finish(run){const arn=executionArn(MACHINE,'db-'+run);await client.send(new sdk.TransactWriteItemsCommand(taskParameters(run,arn)));states.set(arn,'SUCCEEDED');},async close(){await client.send(new sdk.DeleteTableCommand({TableName:table}));}};
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
  for(const action of ['resume-cutover-consumers','recover-cutover-hold','retry-cutover-consumers','release-cutover-hold'])await assert.rejects(f.broker({action,run_id:run}),/MUTATION_RECOVERY/);assert.equal(f.calls.filter(c=>c.command==='RedriveExecution').length,0);assert.ok(await f.get('maintenance'));
 }finally{await f.close();}
});
test('completion response loss and repeated stage execution do not change the original admission plan',async()=>{
 const {f,run}=await preparedControl();try{
  await f.broker({action:'pause-cutover-consumers',run_id:run});const stage=await consumerStage(f,run,'pause',{loseCompletion:true});assert.equal((await stage.run()).consumers_paused,true);const updates=stage.updates;assert.equal((await stage.run()).consumers_paused,true);assert.equal(stage.updates,updates);
 }finally{await f.close();}
});
test('consumer mutation controls are disabled unless the separate capability is enabled',async()=>{
 const f=await fixture();try{const {run_id:run}=await f.start();for(const action of ['pause-cutover-consumers','resume-cutover-consumers','retry-cutover-consumers'])await assert.rejects(f.broker({action,run_id:run}),/CONTROL_DISABLED/);assert.equal((await f.get('run#'+run)).cutover_phase.S,'holding');}finally{await f.close();}
});
test('redrive checks older build pages before accepting that no build remains active',async()=>{
 let includeOlder=false;
 const f=await fixture({consumerControlEnabled:true,listBuilds:input=>!includeOlder?{ids:[]}:input.nextToken?{ids:['active-late']}:{ids:['finished'],nextToken:'older'}});
 try{
  const {run_id:run}=await f.start();await f.broker({action:'prepare-cutover-consumers',run_id:run});await preparation(f,run).run();await f.broker({action:'pause-cutover-consumers',run_id:run});f.states.set(executionArn(MACHINE,'db-'+run),'FAILED');includeOlder=true;
  await assert.rejects(f.broker({action:'retry-cutover-consumers',run_id:run}),/PREVIOUS_BUILD_STILL_RUNNING/);assert.equal(f.calls.filter(c=>c.command==='RedriveExecution').length,0);assert.ok(f.calls.some(c=>c.command==='ListBuildsForProject'&&c.value.nextToken==='older'));assert.ok(await f.get('maintenance'));
 }finally{await f.close();}
});
