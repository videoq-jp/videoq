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
 return{start,get,put,release};
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
