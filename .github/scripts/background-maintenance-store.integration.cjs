// Opt-in test against an empty, disposable DynamoDB Local instance. Never use
// host AWS credentials or accept a remote endpoint for the production-named table.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createBackgroundMaintenanceStore}=require('./background-maintenance-store.cjs');
async function verifyBackgroundStoreTransactions({endpoint}){
 const url=new URL(endpoint);
 assert.ok(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Number(url.port)>=1024&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash,'Only a loopback DynamoDB Local endpoint is allowed');
 const table='videoq-db-maintenance-prod',run='a'.repeat(32),source='b'.repeat(40),execution='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
 const env={PATH:process.env.PATH,AWS_ACCESS_KEY_ID:'localtest',AWS_SECRET_ACCESS_KEY:'localtest',AWS_EC2_METADATA_DISABLED:'true',AWS_CONFIG_FILE:'/dev/null',AWS_SHARED_CREDENTIALS_FILE:'/dev/null',AWS_PAGER:''};
 const native=(command,input)=>{
  const directory=mkdtempSync(join(tmpdir(),'videoq-local-ddb-')),file=join(directory,'input.json');
  try{
   writeFileSync(file,JSON.stringify(input),{mode:0o600});
   const text=execFileSync('aws',['dynamodb',command,'--endpoint-url',url.origin,'--region','ap-northeast-1','--output','json','--no-cli-pager','--cli-input-json','file://'+file],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000,maxBuffer:1024*1024});
   return text.trim()?JSON.parse(text):{};
  }finally{rmSync(directory,{recursive:true,force:true});}
 };
 const lock={pk:{S:'maintenance'},kind:{S:'migration'},execution_arn:{S:execution},input:{S:JSON.stringify({kind:'migration',source_sha:source,writers_stopped:true})}};
 let created=false;
 try{
  // If the table already exists, fail without deleting or modifying it.
  native('create-table',{TableName:table,KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST'});created=true;
  native('put-item',{TableName:table,Item:lock});
  native('put-item',{TableName:table,Item:{pk:{S:'run#'+run},kind:{S:'migration'},execution_arn:{S:execution}}});
  let loseAck=true,race=false;
  const aws=async(service,command,input)=>{
   assert.equal(service,'dynamodb');
   if(command==='transact-write-items'&&race){race=false;native('put-item',{TableName:table,Item:{...lock,execution_arn:{S:execution+'-changed'}}});}
   const response=native(command,input);
   if(command==='transact-write-items'&&loseAck){loseAck=false;throw Error('simulated lost acknowledgement after actual transaction');}
   return response;
  };
  const create=()=>createBackgroundMaintenanceStore({aws,run,source,assertOwnership:async()=>{}});
  const original={pausedObservedAt:123,queuePlanSha256:'c'.repeat(64)};
  await create().save('background-drain',original);
  assert.deepEqual(await create().load('background-drain'),original);
  await create().save('background-drain',original);
  await assert.rejects(create().save('background-drain',{...original,pausedObservedAt:456}),/WRITE_FAILED/);
  race=true;await assert.rejects(create().save('background-queues',{value:'must-not-be-persisted'}));
  const row=native('get-item',{TableName:table,Key:{pk:{S:'run#'+run}},ConsistentRead:true}).Item;
  assert.equal(row.background_queues,undefined);
  assert.deepEqual(JSON.parse(row.background_drain.S).value,original);
  native('put-item',{TableName:table,Item:lock});
  assert.deepEqual(await create().load('background-drain'),original);
 }finally{
  if(created)native('delete-table',{TableName:table});
 }
}
module.exports={verifyBackgroundStoreTransactions};
if(require.main===module){
 const endpoint=process.env.VIDEOQ_LOCAL_DYNAMODB_ENDPOINT;
 test('actual DynamoDB transactions preserve immutable plans and reject ownership races',{skip:!endpoint},()=>verifyBackgroundStoreTransactions({endpoint}));
}
