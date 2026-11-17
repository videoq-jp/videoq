// Real DynamoDB Local transactions; SFN/CodeBuild are explicit test transports.
// No production endpoint, credential provider, database or queue is contacted.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const sdk=require('../../infra/db-maintenance/runtime/node_modules/@aws-sdk/client-dynamodb');
const {NodeHttpHandler}=require('../../infra/db-maintenance/runtime/node_modules/@smithy/node-http-handler');
const {createBroker}=require('../../infra/db-maintenance/runtime/broker.cjs');
const {definition}=require('../../infra/db-maintenance/state-machine.cjs');
const {createResourceJournal,RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const {createResourceCoordinator}=require('./d1-resource-coordinator.cjs');
const {D1_HOLD_KIND,executionArn}=require('../../infra/db-maintenance/runtime/policy.cjs');
const MACHINE='arn:aws:states:ap-northeast-1:257240362763:stateMachine:videoq-db-maintenance-prod',SHA='a'.repeat(40);
const IMAGE='amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86';
const name='videoq-d1-hold-'+randomUUID().replaceAll('-',''),execute=promisify(execFile),label='d1-resource-hold-fixture';
const docker=args=>execute('docker',args,{timeout:120000,maxBuffer:1024*1024});
let client;
before(async()=>{
 await docker(['run','--detach','--name',name,'--label','videoq-purpose='+label,'--memory','512m','-p','127.0.0.1::8000','--entrypoint','java','--workdir','/home/dynamodblocal',IMAGE,'-Xmx256m','-Djava.library.path=./DynamoDBLocal_lib','-jar','DynamoDBLocal.jar','-inMemory','-sharedDb']);
 const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.Config.Labels['videoq-purpose'],label);
 const port=Number(info.NetworkSettings.Ports['8000/tcp'][0].HostPort);assert.ok(Number.isInteger(port)&&port>0&&port<65536);
 client=new sdk.DynamoDBClient({region:'ap-northeast-1',endpoint:'http://127.0.0.1:'+port,credentials:{accessKeyId:'DUMMYIDEXAMPLE',secretAccessKey:'DUMMYEXAMPLEKEY'},maxAttempts:1,requestHandler:new NodeHttpHandler({connectionTimeout:1000,socketTimeout:2000})});
 const until=Date.now()+60000;let ready=false;
 while(Date.now()<until){try{await client.send(new sdk.ListTablesCommand({Limit:1}));ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
 assert.ok(ready);
},{timeout:90000});
after(async()=>{
 client?.destroy();
 try{const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.Config.Labels['videoq-purpose'],label);await docker(['rm','--force','--volumes',name]);}
 catch(e){if(!String(e.stderr||'').includes('No such object'))throw e;}
},{timeout:30000});
async function fixture(){
 const table='videoq_d1_hold_'+randomUUID().replaceAll('-','');
 await client.send(new sdk.CreateTableCommand({TableName:table,BillingMode:'PAY_PER_REQUEST',KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}]}));
 const states=new Map();
 const aws=async(service,command,value)=>{
  if(service==='ddb')return client.send(new sdk[command+'Command'](value));
  if(command==='ListBuildsForProject')return{ids:[]};
  if(command==='StartExecution'){states.set(executionArn(MACHINE,value.name),'RUNNING');return{};}
  if(command==='DescribeExecution')return{status:states.get(value.executionArn)};
  if(command==='DescribeStateMachineForExecution')return{definition:JSON.stringify(definition({table:'videoq-db-maintenance-prod',projects:{},neonRetired:true}))};
  throw Error('Unexpected fixture operation');
 };
 const broker=createBroker(aws,{table,machine:MACHINE,projects:['migration','smoke','deploy'],allowedKinds:['migration',D1_HOLD_KIND]},async()=>SHA);
 const get=async key=>(await client.send(new sdk.GetItemCommand({TableName:table,Key:{pk:{S:key}},ConsistentRead:true}))).Item;
 const put=row=>client.send(new sdk.PutItemCommand({TableName:table,Item:row}));
 const start=token=>broker({action:'start',kind:D1_HOLD_KIND,source_sha:SHA,client_token:token});
 const release=(run,arn)=>{
  const input=definition({table,projects:{},neonRetired:true}).States.ReleaseD1ResourceHold.Parameters;
  function resolve(value){
   if(Array.isArray(value))return value.map(resolve);
   if(!value||typeof value!=='object')return value;
   return Object.fromEntries(Object.entries(value).map(([key,v])=>{
    if(key==='Bool')return['BOOL',v];
    if(key!=='S.$')return[key,resolve(v)];
    const resolved=v==='$$.Execution.Id'?arn:v==='$.source_sha'?SHA:v==="States.Format('run#{}', $.run_id)"?'run#'+run:null;
    assert.ok(resolved);return['S',resolved];
   }));
  }
  return client.send(new sdk.TransactWriteItemsCommand(resolve(input)));
 };
 const journal=(run,{loseResponse=false,stealBeforeWrite=false,executorToken}={})=>createResourceJournal({run,source:SHA,executorToken,enabled:true,expectedDefinitionHash:resourceDigest(definition({table:'videoq-db-maintenance-prod',projects:{},neonRetired:true})),aws:async(service,command,value)=>{
  if(service!=='ddb')return aws(service,command,value);
  const local=structuredClone(value),remap=op=>{assert.equal(op.TableName,'videoq-db-maintenance-prod');op.TableName=table;};
  if(local.TransactItems){for(const op of local.TransactItems)for(const data of Object.values(op))remap(data);}
  else remap(local);
  if(command==='TransactWriteItems'&&stealBeforeWrite){stealBeforeWrite=false;const owner=await get('maintenance');await put({...owner,execution_arn:{S:owner.execution_arn.S+'changed'}});}
  const result=await aws(service,command,local);
  if(command==='TransactWriteItems'&&loseResponse){loseResponse=false;throw Error('SYNTHETIC_LOST_RESPONSE');}
  return result;
 }});
 const completion=(run,executorToken,verifyCurrentState)=>require('./d1-resource-completion.cjs').createResourceCompletion({run,source:SHA,executorToken,journal:journal(run,{executorToken}),verifyCurrentState,enabled:true,aws:async(service,command,value)=>{
  assert.equal(service,'ddb');const local=structuredClone(value),remap=op=>{assert.equal(op.TableName,'videoq-db-maintenance-prod');op.TableName=table;};
  if(local.TransactItems){for(const item of local.TransactItems)for(const operation of Object.values(item))remap(operation);}else remap(local);
  return aws(service,command,local);
 }});
 const metadataAws=async(service,command,value)=>{
  assert.equal(service,'ddb');const local=structuredClone(value),remap=op=>{assert.equal(op.TableName,'videoq-db-maintenance-prod');op.TableName=table;};
  if(local.TransactItems){for(const item of local.TransactItems)for(const operation of Object.values(item))remap(operation);}else remap(local);
  return aws(service,command,local);
 };
 return{start,get,put,release,journal,completion,metadataAws};
}
function completed(row,phase='verified'){
 return{...row,resource_phase:{S:phase},release_requested:{BOOL:true},api_admission_restored:{BOOL:true},consumer_admission_restored:{BOOL:true},deployment_admission_restored:{BOOL:true},resource_completion_receipt:{S:'synthetic receipt'},resource_completion_receipt_sha256:{S:'c'.repeat(64)}};
}
test('competing D1 holds acquire exactly one real atomic maintenance lock',async()=>{
 const f=await fixture(),results=await Promise.all(['b','c'].map(c=>f.start(c.repeat(32))));
 assert.equal(results.filter(r=>r.status==='RUNNING').length,1);assert.equal(results.filter(r=>r.status==='BUSY').length,1);
 const owner=await f.get('maintenance');assert.equal(owner.kind.S,D1_HOLD_KIND);
});
test('real release transaction refuses missing proof, failed admissions, changed source and lost ownership',async()=>{
 const f=await fixture(),r=await f.start('d'.repeat(32)),key='run#'+r.run_id,initial=await f.get(key),owner=await f.get('maintenance');
 const valid=completed(initial);
 const fields=['resource_completion_receipt','resource_completion_receipt_sha256','api_admission_restored','consumer_admission_restored','deployment_admission_restored'];
 for(const field of fields){const row={...valid};delete row[field];await f.put(row);await assert.rejects(f.release(r.run_id,owner.execution_arn.S),{name:'TransactionCanceledException'});assert.ok(await f.get('maintenance'));}
 for(const change of [{source_sha:{S:'e'.repeat(40)}},{release_requested:{BOOL:false}},{resource_phase:{S:'holding'}},{kind:{S:'migration'}}]){
  await f.put({...valid,...change});await assert.rejects(f.release(r.run_id,owner.execution_arn.S),{name:'TransactionCanceledException'});assert.ok(await f.get('maintenance'));
 }
 await f.put(valid);await f.put({...owner,execution_arn:{S:owner.execution_arn.S+'changed'}});
 await assert.rejects(f.release(r.run_id,owner.execution_arn.S),{name:'TransactionCanceledException'});assert.ok(await f.get('maintenance'));
});
test('verified completion and explicit abort release only their own lock and retain the journal',async()=>{
 for(const phase of ['verified','aborted']){
  const f=await fixture(),r=await f.start((phase==='verified'?'e':'f').repeat(32)),row=await f.get('run#'+r.run_id),owner=await f.get('maintenance');
  await f.put(completed(row,phase));await f.release(r.run_id,owner.execution_arn.S);
  assert.equal(await f.get('maintenance'),undefined);assert.equal((await f.get('run#'+r.run_id)).resource_phase.S,phase);
 }
});

test('resource journal real CAS preserves ordering, immutable proofs and reconciles a lost response',async()=>{
 const f=await fixture(),r=await f.start('a'.repeat(32)),j=f.journal(r.run_id,{loseResponse:true}),plan=step=>({step,planSha256:'b'.repeat(64)});
 const first=await j.begin(plan(RESOURCE_STEPS[0]));assert.equal(first.state,'intent');assert.deepEqual(await j.begin(plan(RESOURCE_STEPS[0])),first);
 assert.equal((await f.get('run#'+r.run_id)).resource_revision.N,'1');
 await assert.rejects(j.begin(plan(RESOURCE_STEPS[1])),/ORDER_REQUIRED/);
 await j.verify({...plan(RESOURCE_STEPS[0]),receiptSha256:'c'.repeat(64)});
 await assert.rejects(j.verify({...plan(RESOURCE_STEPS[0]),receiptSha256:'d'.repeat(64)}),/PROOF_CHANGED/);
 await j.begin(plan(RESOURCE_STEPS[1]));assert.equal((await j.inspect()).nextStep,RESOURCE_STEPS[1]);
});
test('resource journal real CAS preserves one concurrent intent and rejects ownership stolen before commit',async()=>{
 const f=await fixture(),r=await f.start('1'.repeat(32)),j=f.journal(r.run_id),plan={step:RESOURCE_STEPS[0],planSha256:'e'.repeat(64)};
 const results=await Promise.allSettled([j.begin(plan),j.begin(plan)]);assert.ok(results.some(v=>v.status==='fulfilled'));
 assert.equal((await j.inspect()).steps.length,1);assert.equal((await f.get('run#'+r.run_id)).resource_revision.N,'1');
 const g=await fixture(),s=await g.start('2'.repeat(32)),stolen=g.journal(s.run_id,{stealBeforeWrite:true});
 await assert.rejects(stolen.begin(plan),{name:'TransactionCanceledException'});
 assert.equal((await g.get('run#'+s.run_id)).resource_steps,undefined);
});

test('full coordinator engine records ordered intent and proof through real DDB without repeating a lost-response apply',async()=>{
 const f=await fixture(),r=await f.start('3'.repeat(32)),j=f.journal(r.run_id),plans=new Map(),applied=new Set();let lost=true,mutations=0;
 const adapters=Object.fromEntries(RESOURCE_STEPS.map(step=>[step,{prepare:async()=>({step,original:'synthetic metadata'}),probe:async()=>applied.has(step)?{state:'applied',receiptSha256:resourceDigest({step})}:{state:'not-applied'},apply:async(_plan,context)=>{await context.assertOwnership();mutations++;applied.add(step);if(lost){lost=false;throw Error('synthetic lost response');}}}]));
 const engine=createResourceCoordinator({journal:j,adapters,plans:{load:async step=>plans.get(step)??null,save:async(step,plan)=>{plans.set(step,plan);}},assertEnvironment:async()=>{},enabled:true});
 for(const step of RESOURCE_STEPS)assert.equal((await engine.runNext()).step,step);
 assert.equal((await engine.runNext()).holdReleased,false);assert.equal(mutations,RESOURCE_STEPS.length);
 const recorded=await j.inspect();assert.equal(recorded.nextStep,null);assert.ok(recorded.steps.every(r=>r.state==='verified'));
 assert.ok(await f.get('maintenance'));await assert.rejects(j.assertPrePromotionAbort(),/FORWARD_RECOVERY/);
});
test('real executor CAS admits one token and rejects tokenless or replaced execution',async()=>{
 const f=await fixture(),r=await f.start(),a=f.journal(r.run_id,{executorToken:'1'.repeat(64)}),b=f.journal(r.run_id,{executorToken:'2'.repeat(64)});
 const attempts=await Promise.allSettled([a.claimExecutor(),b.claimExecutor()]);assert.equal(attempts.filter(v=>v.status==='fulfilled').length,1);
 const winner=attempts[0].status==='fulfilled'?a:b,loser=winner===a?b:a;
 await winner.assertExecutor();await assert.rejects(loser.assertExecutor(),/EXECUTOR_OWNERSHIP/);await assert.rejects(f.journal(r.run_id).inspect(),/EXECUTOR_OWNERSHIP/);
 await winner.begin({step:RESOURCE_STEPS[0],planSha256:'c'.repeat(64)});
 const row=await f.get('run#'+r.run_id);await f.put({...row,resource_executor_sha256:{S:'f'.repeat(64)}});await assert.rejects(winner.assertExecutor(),/EXECUTOR_OWNERSHIP/);
});

test('real claimed journal and pending operation authorize the Python pipe worker',async()=>{
 const {createResourceBridge}=require('./d1-resource-bridge.cjs');
 const f=await fixture(),r=await f.start(),j=f.journal(r.run_id,{executorToken:'1'.repeat(64)});
 await j.claimExecutor();const pending={step:RESOURCE_STEPS[0],planSha256:'c'.repeat(64)};await j.begin(pending);
 const bridge=createResourceBridge({assertExecutor:()=>j.assertExecutor(),assertOperation:()=>j.assertPending(pending),assertTargetSafe:async()=>{throw Error('TARGET_NOT_AUTHORIZED');},enabled:true});
 assert.deepEqual(await bridge.call('ownership-check',{}),{owned:true});
 await j.verify({...pending,receiptSha256:'d'.repeat(64)});
 await assert.rejects(bridge.call('ownership-check',{}),/BRIDGE_OWNERSHIP_REQUIRED/);
});

test('completion gate preserves owner until durable proof and real conditional ASL release',async()=>{
 const f=await fixture(),r=await f.start(),token='1'.repeat(64),j=f.journal(r.run_id,{executorToken:token}),proofSha='d'.repeat(64);
 await j.claimExecutor();
 const current={apiAdmissionRestored:true,consumerAdmissionRestored:true,deploymentAdmissionRestored:true,sourceFenced:true,targetUnfenced:true,
  accountId:'12daec56fdba43f677f2766ee26a5a39',databaseId:'587bd210-6d9d-4f32-abb7-a490013e65d3',largeIndex:'videoq-prod-scenes-1536',smallIndex:'videoq-prod-scenes-768',apiVersion:'11111111-1111-1111-1111-111111111111',
  smokeBuildArn:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:22222222-2222-2222-2222-222222222222',smokeSourceSha:SHA,smokeCompletedAt:'2026-11-17T00:00:00.000Z',e2eStepReceiptSha256:proofSha};
 const completion=f.completion(r.run_id,token,async()=>current);
 await assert.rejects(completion.request(),/ALL_STEPS/);
 for(const step of RESOURCE_STEPS){const value={step,planSha256:'c'.repeat(64)};await j.begin(value);await j.verify({...value,receiptSha256:proofSha});}
 current.sourceFenced=false;await assert.rejects(completion.request(),/CURRENT_PROOF/);assert.equal((await f.get('run#'+r.run_id)).release_requested.BOOL,false);
 current.sourceFenced=true;const receipt=await completion.request();assert.equal(receipt.releaseRequested,true);assert.ok(await f.get('maintenance'));
 const owner=await f.get('maintenance');await f.release(r.run_id,owner.execution_arn.S);assert.equal(await f.get('maintenance'),undefined);assert.deepEqual(await completion.request(),receipt);
});

test('native launch registration uses real revision-checked transactions before worker access',async()=>{
 const f=await fixture(),r=await f.start('7'.repeat(32)),executorToken='8'.repeat(64),j=f.journal(r.run_id,{executorToken});await j.claimExecutor();
 for(const step of RESOURCE_STEPS.slice(0,10)){const sha=resourceDigest({step});await j.begin({step,planSha256:sha});await j.verify({step,planSha256:sha,receiptSha256:resourceDigest({verified:step})});}
 const plan={nativePlan:{actionId:'9'.repeat(32),sourceVersion:'immutable',notBefore:'2026-11-17T00:00:00Z'}};await j.begin({step:'verify-e2e',planSha256:resourceDigest(plan)});
 const arn='arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:11111111-1111-1111-1111-111111111111';let starts=0,loseWrite=true;
 const launcher=require('./d1-resource-smoke-launcher.cjs').createResourceSmokeLauncher({run:r.run_id,source:SHA,executorSha256:resourceDigest({executorToken}),journal:j,enabled:true,
  proof:{launchInput:async()=>({projectName:'videoq-db-smoke-prod',sourceVersion:'immutable',idempotencyToken:plan.nativePlan.actionId}),matchesBuild:async()=>true,status:async()=>({state:'pending'})},
  aws:async(service,command,input)=>{
   if(service==='ddb'){const result=await f.metadataAws(service,command,input);if(command==='TransactWriteItems'&&loseWrite){loseWrite=false;throw Error('SYNTHETIC_LOST_WRITE_RESPONSE');}return result;}
   assert.equal(command,'StartBuild');starts++;const row=await f.get('run#'+r.run_id);assert.equal(row.resource_smoke_action_id.S,plan.nativePlan.actionId);assert.equal(row.resource_smoke_build_arn,undefined);return{build:{arn}};
  }});
 await launcher.advance(plan);assert.equal((await f.get('run#'+r.run_id)).resource_smoke_build_arn.S,arn);await launcher.advance(plan);assert.equal(starts,1);
 await j.verify({step:'verify-e2e',planSha256:resourceDigest(plan),receiptSha256:'a'.repeat(64)});assert.equal(await launcher.readBuild(plan),arn);
 const owner=await f.get('maintenance');await f.put({...owner,execution_arn:{S:owner.execution_arn.S+'changed'}});await assert.rejects(launcher.readBuild(plan),/OWNERSHIP/);
});
test('real abort request CAS excludes ordinary progress and cannot be requested after promotion intent',async()=>{
 const f=await fixture(),r=await f.start('6'.repeat(32)),executorToken='7'.repeat(64),j=f.journal(r.run_id,{executorToken});await j.claimExecutor();
 await j.begin({step:RESOURCE_STEPS[0],planSha256:'c'.repeat(64)});await j.requestAbort();await j.requestAbort();assert.equal((await j.assertAbortExecutor()).run,r.run_id);assert.ok(await f.get('maintenance'));
 await assert.rejects(j.assertExecutor(),/ABORT_IN_PROGRESS/);await assert.rejects(j.verify({step:RESOURCE_STEPS[0],planSha256:'c'.repeat(64),receiptSha256:'d'.repeat(64)}),/ABORT_IN_PROGRESS/);
 const g=await fixture(),s=await g.start('5'.repeat(32)),k=g.journal(s.run_id,{executorToken});await k.claimExecutor();
 for(const step of RESOURCE_STEPS){await k.begin({step,planSha256:'c'.repeat(64)});if(step==='promote-bindings')break;await k.verify({step,planSha256:'c'.repeat(64),receiptSha256:'d'.repeat(64)});}
 await assert.rejects(k.requestAbort(),/FORWARD_RECOVERY/);assert.equal((await g.get('run#'+s.run_id)).resource_abort_requested,undefined);
});
test('abort recovery durable receipt authorizes only the existing real conditional ASL release',async()=>{
 const f=await fixture(),r=await f.start('4'.repeat(32)),executorToken='6'.repeat(64),j=f.journal(r.run_id,{executorToken});await j.claimExecutor();
 const version='11111111-1111-1111-1111-111111111111',settings={compatibility_date:'2026-08-20',bindings:[{name:'DB',type:'d1',id:'e57d0931-18cb-4f00-ae7f-b0068030fb04'},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:'videoq-scenes-migration-v3-1536'},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:'videoq-scenes-migration-v3-768'}]};
 const cloudflare=async(method,path)=>{assert.equal(method,'GET');if(path.endsWith('/deployments'))return{deployments:[{id:version,versions:[{version_id:version,percentage:100}]}]};if(path.endsWith('/versions?per_page=1'))return{items:[{id:version}]};return structuredClone(settings);};
 const fail=async()=>assert.fail('No admission mutation before original intent');let lose=true;
 const recovery=require('./d1-resource-abort-recovery.cjs').createResourceAbortRecovery({run:r.run_id,source:SHA,executorToken,journal:j,plans:{load:fail},cloudflare,lambda:fail,github:fail,sourceFence:{inspect:fail,remove:fail,assertUnfenced:async()=>resourceDigest({unfenced:true})},enabled:true,aws:async(service,command,input)=>{const result=await f.metadataAws(service,command,input);if(command==='TransactWriteItems'&&lose){lose=false;throw Error('SYNTHETIC_LOST_ABORT_COMPLETION_RESPONSE');}return result;}});
 const result=await recovery.advance();assert.equal(result.status,'abort-release-requested');const owner=await f.get('maintenance');assert.ok(owner);const row=await f.get('run#'+r.run_id);assert.equal(row.resource_phase.S,'aborted');assert.equal(row.resource_abort_requested.BOOL,true);assert.deepEqual(await recovery.advance(),result);
 await f.release(r.run_id,owner.execution_arn.S);assert.equal(await f.get('maintenance'),undefined);assert.equal((await f.get('run#'+r.run_id)).resource_completion_receipt_sha256.S,result.receiptSha256);
});
