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
 return{start,get,put,release,journal};
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
