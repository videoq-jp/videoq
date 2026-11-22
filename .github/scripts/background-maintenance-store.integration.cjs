// Opt-in test against an empty, disposable DynamoDB Local instance. Never use
// host AWS credentials or accept a remote endpoint for the production-named table.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {execFileSync,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createBackgroundMaintenanceStore}=require('./background-maintenance-store.cjs');
const {createCanonicalBackgroundMaintenance,verifyBackgroundMaintenance}=require('./canonical-background-maintenance.cjs');
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

  // Exercise the complete coordinator against the real transaction store,
  // rebuilding it after each failure. Cloudflare and the clock are explicitly
  // test transports; this does not claim a production pause or elapsed drain.
  native('put-item',{TableName:table,Item:{pk:{S:'run#'+run},kind:{S:'migration'},execution_arn:{S:execution}}});
  const queues=['account','search'].map((kind,i)=>({queue_id:String(i+1).repeat(32),queue_name:`videoq-${kind}-prod`,settings:{message_retention_period:345600,delivery_paused:i===1},consumers:[{type:'worker',script:'videoq-api',dead_letter_queue:`videoq-${kind}-dlq-prod`}]}));
  const workflows=['running','paused'].map((status,i)=>({id:'recovery-'+i,status,version_id:'11111111-2222-4333-8444-555555555555'}));
  // Leave the event loop free during this longer sequence so the enclosing
  // integration suite can process closures of its idle SDK connections.
  const asyncAws=async(service,command,input)=>{
   assert.equal(service,'dynamodb');
   const directory=mkdtempSync(join(tmpdir(),'videoq-local-ddb-')),file=join(directory,'input.json');
   try{
    writeFileSync(file,JSON.stringify(input),{mode:0o600});
    const {stdout}=await promisify(execFile)('aws',['dynamodb',command,'--endpoint-url',url.origin,'--region','ap-northeast-1','--output','json','--no-cli-pager','--cli-input-json','file://'+file],{env,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
    return stdout.trim()?JSON.parse(stdout):{};
   }finally{rmSync(directory,{recursive:true,force:true});}
  };
  let clock=1000,writes=0,dropAcknowledgement=false;
  const fetcher=async(url,options)=>{
   assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/12daec56fdba43f677f2766ee26a5a39/'));
   if(options.method==='GET')return Response.json({success:true,result:structuredClone(url.includes('/workflows/')?workflows:url.includes('/queues?')?queues:queues.find(row=>url.endsWith('/'+row.queue_id)))});
   assert.equal(options.method,'PATCH');const body=JSON.parse(options.body);writes++;
   if(url.includes('/workflows/'))workflows.find(row=>url.endsWith('/'+row.id+'/status')).status=body.status==='pause'?'paused':'running';
   else Object.assign(queues.find(row=>url.endsWith('/'+row.queue_id)).settings,body.settings);
   if(dropAcknowledgement){dropAcknowledgement=false;throw Error('lost provider acknowledgement');}
   return Response.json({success:true});
  };
  const controller=()=>createCanonicalBackgroundMaintenance({aws:asyncAws,run,source,credential:{CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'isolated-test-token-not-a-credential'},fetcher,assertOwnership:async()=>{},assertApiPaused:async()=>{},now:()=>clock,sleep:async()=>{clock+=16*60*1000;}});
  await controller().pause();
  const savedQueues=native('get-item',{TableName:table,Key:{pk:{S:'run#'+run}},ConsistentRead:true}).Item.background_queues.S;
  assert.ok(queues.every(row=>row.settings.delivery_paused));
  assert.ok(workflows.every(row=>row.status==='paused'));
  // Failed schema work has no completion proof: a replacement process must
  // leave admission closed rather than restoring on the basis of a lost caller.
  const beforeUnsafeRestore=writes;
  await assert.rejects(controller().restore(),/SCHEMA_PROOF_REQUIRED/);
  assert.equal(writes,beforeUnsafeRestore);
  await controller().pause();
  await controller().markComplete();
  // Crash after the durable success record, then lose a resume response. A new
  // controller must reconcile it without re-running schema work or overwriting
  // the original paused consumer/Workflow baselines.
  assert.equal(await controller().completed(),true);
  dropAcknowledgement=true;
  await controller().restore();
  assert.deepEqual(queues.map(row=>row.settings.delivery_paused),[false,true]);
  assert.deepEqual(workflows.map(row=>row.status),['running','paused']);
  assert.equal(native('get-item',{TableName:table,Key:{pk:{S:'run#'+run}},ConsistentRead:true}).Item.background_queues.S,savedQueues);
  const restoredWrites=writes;
  await controller().restore();assert.equal(writes,restoredWrites);
  await assert.rejects(controller().pause(),/RESTORE_ALREADY_STARTED/);
  native('put-item',{TableName:table,Item:{...lock,execution_arn:{S:execution+'-changed'}}});
  await assert.rejects(controller().restore(),/LOCK_REQUIRED/);
  assert.equal(writes,restoredWrites);
  // The production rehearsal is owned by a distinct, explicitly non-schema
  // request. Its real DynamoDB records must never authorize schema work.
  const verificationLock={...lock,input:{S:JSON.stringify({kind:'migration',source_sha:source,writers_stopped:false,background_verification:true})}};
  native('put-item',{TableName:table,Item:verificationLock});
  native('put-item',{TableName:table,Item:{pk:{S:'run#'+run},kind:{S:'migration'},execution_arn:{S:execution}}});
  const verify=()=>verifyBackgroundMaintenance({aws:asyncAws,run,source,credential:{CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'isolated-test-token-not-a-credential'},fetcher,assertOwnership:async()=>{},assertProducerAdmissionClosed:async()=>{},now:()=>clock,sleep:async()=>{clock+=16*60*1000;}});
  await assert.rejects(verify(),/BACKGROUND_VERIFICATION_RECOVERY_REQUIRED/);
  assert.ok(queues.every(row=>row.settings.delivery_paused));
  const verificationOriginal=native('get-item',{TableName:table,Key:{pk:{S:'run#'+run}},ConsistentRead:true}).Item.background_queues.S;
  dropAcknowledgement=true;assert.equal((await verify()).status,'restored');
  assert.deepEqual(queues.map(row=>row.settings.delivery_paused),[false,true]);
  assert.deepEqual(workflows.map(row=>row.status),['running','paused']);
  const verificationRow=native('get-item',{TableName:table,Key:{pk:{S:'run#'+run}},ConsistentRead:true}).Item;
  assert.equal(verificationRow.background_queues.S,verificationOriginal);
  assert.ok(verificationRow.background_verification_complete);
  assert.equal(verificationRow.background_schema_complete,undefined);
 }finally{
  if(created)native('delete-table',{TableName:table});
 }
}
module.exports={verifyBackgroundStoreTransactions};
if(require.main===module){
 const endpoint=process.env.VIDEOQ_LOCAL_DYNAMODB_ENDPOINT;
 test('actual DynamoDB transactions preserve immutable plans and reject ownership races',{skip:!endpoint},()=>verifyBackgroundStoreTransactions({endpoint}));
}
