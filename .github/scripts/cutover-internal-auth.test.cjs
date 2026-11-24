const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {provisionInternalAuth}=require('./cutover-internal-auth.cjs');
const {TARGET}=require('./cutover-final-context.cjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(options={}){
 const run='a'.repeat(32),source='b'.repeat(40),action='c'.repeat(32),arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run,secret='d'.repeat(64);
 const consumer={version:1,operationId:randomUUID(),scope:{purpose:'production'},consumers:['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'].map(functionName=>({functionName,functionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+functionName,queueArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+functionName,mappingUuid:randomUUID(),wasEnabled:true}))};
 const receipt=JSON.stringify({version:1,runId:run,sourceSha:source,phase:'verify',complete:true,productionActive:false,target:TARGET});
 const row={kind:{S:'cutover-hold'},execution_arn:{S:arn},source_sha:{S:source},handoff_action_id:{S:action},database_mutations_started:{BOOL:true},release_requested:{BOOL:false},cutover_phase:{S:'consumers-paused'},cutover_revision:{N:'3'},postgres_fence_state:{S:'fenced'},api_pause_verified:{BOOL:true},api_admission_restored:{BOOL:false},deployment_admission_restored:{BOOL:false},consumer_admission_restored:{BOOL:false},transfer_verify_receipt:{S:receipt},transfer_verify_receipt_sha256:{S:hash(receipt)},consumer_plan:{S:JSON.stringify(consumer)},consumer_plan_sha256:{S:hash(JSON.stringify(consumer))}};
 const owner={kind:{S:'cutover-hold'},execution_arn:{S:arn}};let version=1,keyParameter=null;
 const app={BETTER_AUTH_SECRET:'synthetic-user-auth-must-stay',OPENAI_API_KEY:'synthetic-llm-must-stay',nested:{unknown:'preserve'},parameterVersion:'legitimate-application-field'};if(options.existingAppKey)app.WORKER_INTERNAL_API_SECRET=secret;
 const settings={compatibility_date:'2026-11-14',bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'},{name:'HYPERDRIVE',type:'hyperdrive',id:'synthetic-hyperdrive'},{name:'BETTER_AUTH_SECRET',type:'secret_text'}]};if(options.preexistingBinding)settings.bindings.push({name:'WORKER_INTERNAL_API_SECRET',type:'secret_text'});
 let activeVersion=randomUUID(),cfWrites=0,appWrites=0,serverSecret;
 const env={VIDEOQ_CUTOVER_FINAL_HANDOFF:'true',MAINTENANCE_KIND:'cutover-hold',MAINTENANCE_STAGE:'cutover-internal-auth',MAINTENANCE_TABLE:'videoq-db-maintenance-prod',MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_HANDOFF_ACTION_ID:action,CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:'+randomUUID()};
 const aws=async(service,command,input)=>{
  if(service==='dynamodb'){
   if(command==='get-item')return{Item:structuredClone(input.Key.pk.S==='maintenance'?owner:row)};
   assert.equal(command,'transact-write-items');const update=input.TransactItems[0].Update,v=update.ExpressionAttributeValues;
   if(options.loseOwnerAtIntent&&!row.internal_auth_intent)owner.execution_arn.S+='other';
   assert.equal(owner.execution_arn.S,v[':execution'].S);assert.equal(row.cutover_revision.N,v[':previous'].N);assert.equal(row.database_mutations_started.BOOL,true);assert.match(update.ConditionExpression,/postgres_fence_state=:fenced/);
   if(!row.internal_auth_intent)assert.match(update.ConditionExpression,/attribute_not_exists\(internal_auth_intent\)/);
   for(const [name,key]of Object.entries(update.ExpressionAttributeNames)){if(name==='#revision')continue;row[key]=v[':f'+name.slice(2)];}row.cutover_revision=v[':next'];
   if(options.lostIntentResponse&&!row.internal_auth_receipt){options.lostIntentResponse=false;throw Error('synthetic lost success');}return{};
  }
  if(service==='lambda'){assert.equal(command,'list-event-source-mappings');const c=consumer.consumers.find(v=>v.functionName===input.FunctionName);return{EventSourceMappings:[{FunctionArn:c.functionArn,EventSourceArn:c.queueArn,UUID:c.mappingUuid,State:'Disabled'}]};}
  assert.equal(service,'ssm');
  if(command==='get-parameter'){assert.equal(input.Name,'/videoq/prod/app');return{Parameter:{Type:'SecureString',Version:version,Value:JSON.stringify(app)}};}
  if(command==='describe-parameters'){
   if(options.changeAppAtDescribe){app.nested.unknown='outside-change';version++;}
   return{Parameters:[{Name:'/videoq/prod/app',Version:version,Tier:'Standard',KeyId:'alias/aws/ssm',DataType:'text'}]};
  }
  assert.equal(command,'put-parameter');assert.equal(input.Type,'SecureString');
  if(input.Name.endsWith('/worker-internal-api')){assert.equal(input.Overwrite,false);keyParameter=JSON.parse(input.Value);return{Version:1};}
  assert.equal(input.Name,'/videoq/prod/app');assert.ok(row.internal_auth_intent);assert.equal(input.KeyId,'alias/aws/ssm');assert.equal(input.Tier,'Standard');const changed=JSON.parse(input.Value);Object.keys(app).forEach(k=>delete app[k]);Object.assign(app,changed);version++;appWrites++;
  if(options.lostAppResponse){options.lostAppResponse=false;throw Error('synthetic lost app success');}return{Version:version};
 };
 const readParameter=async(name,optional)=>{
  if(name==='/videoq/security/prod/cutover-control')return{CLOUDFLARE_ACCOUNT_ID:TARGET.accountId,CLOUDFLARE_API_TOKEN:'synthetic-workers-only-token'};
  assert.equal(name,'/videoq/security/prod/worker-internal-api');if(!keyParameter&&!optional)throw Error('missing synthetic key');return keyParameter;
 };
 const fetcher=async(url,opts)=>{
  if(new URL(url).origin==='https://videoq.jp')return url.endsWith('/health')?Response.json({data:{status:'ok'}}):Response.json({error:{code:'MIGRATION_PAUSED'}},{status:503,headers:{'retry-after':'60','cache-control':'no-store'}});
  if(url.endsWith('/settings')&&opts.method==='PATCH'){
   assert.ok(row.internal_auth_intent);assert.equal(app.WORKER_INTERNAL_API_SECRET,secret);const payload=JSON.parse(await opts.body.get('settings').text());cfWrites++;
   settings.bindings=payload.bindings.map(b=>{if(b.type==='inherit'){const old=settings.bindings.find(x=>x.name===b.name);assert.ok(old);return old;}assert.equal(b.name,'WORKER_INTERNAL_API_SECRET');assert.equal(b.type,'secret_text');serverSecret=b.text;return{name:b.name,type:b.type};});activeVersion=randomUUID();
   if(options.changeOtherBinding)settings.bindings.push({name:'unrelated',type:'plain_text',text:'outside-change'});
   if(options.lostCloudflareResponse){options.lostCloudflareResponse=false;throw Error('synthetic lost worker success');}
  }
  const result=url.endsWith('/deployments')?{deployments:[{id:randomUUID(),versions:[{version_id:activeVersion,percentage:100}]}]}:url.endsWith('/versions?per_page=1')?{items:[{id:activeVersion}]}:settings;
  return Response.json({success:true,result});
 };
 return{args:{env,aws,readParameter,fetcher,random:()=>secret,sleep:async()=>{}},row,owner,app,settings,get cfWrites(){return cfWrites;},get appWrites(){return appWrites;},get serverSecret(){return serverSecret;},get keyParameter(){return keyParameter;}};
}
test('AWS provisioning preserves unknown app/user auth fields and inherits all other Worker bindings',async()=>{
 const f=fixture();assert.deepEqual(await provisionInternalAuth(f.args),{internalAuthPrepared:true,workerProfilesChanged:false,apiBackendChanged:false,admissionPaused:true});assert.equal(f.app.parameterVersion,'legitimate-application-field');assert.equal(f.app.BETTER_AUTH_SECRET,'synthetic-user-auth-must-stay');assert.equal(f.app.nested.unknown,'preserve');assert.equal(f.serverSecret,f.app.WORKER_INTERNAL_API_SECRET);assert.equal(f.row.database_mutations_started.BOOL,true);assert.equal(f.owner.execution_arn.S,f.row.execution_arn.S);assert.equal(JSON.stringify(f.row).includes(f.serverSecret),false);assert.equal(JSON.stringify(f.row).includes('synthetic-user-auth-must-stay'),false);
});
test('a lost successful intent/app/Worker response is reconciled without replacing the shared key',async()=>{
 const f=fixture({lostIntentResponse:true,lostAppResponse:true,lostCloudflareResponse:true});await provisionInternalAuth(f.args);const original=f.row.internal_auth_intent.S,key=f.app.WORKER_INTERNAL_API_SECRET;await provisionInternalAuth(f.args);assert.equal(f.row.internal_auth_intent.S,original);assert.equal(f.app.WORKER_INTERNAL_API_SECRET,key);assert.equal(f.appWrites,1);
});
test('an existing valid app shared key is preserved without allocating or rewriting an app key',async()=>{
 const f=fixture({existingAppKey:true});await provisionInternalAuth(f.args);assert.equal(f.keyParameter,null);assert.equal(f.appWrites,0);assert.equal(f.serverSecret,f.app.WORKER_INTERNAL_API_SECRET);
});
test('a pre-existing unowned binding or lost global owner cannot write app/Worker credentials',async()=>{
 for(const options of [{preexistingBinding:true},{loseOwnerAtIntent:true}]){const f=fixture(options);await assert.rejects(()=>provisionInternalAuth(f.args));assert.equal(f.appWrites,0);assert.equal(f.cfWrites,0);}
});
test('outside changes are never overwritten or recorded as successful authentication preparation',async()=>{
 for(const options of [{changeAppAtDescribe:true},{changeOtherBinding:true}]){const f=fixture(options);await assert.rejects(()=>provisionInternalAuth(f.args));assert.equal(f.row.internal_auth_receipt,undefined);assert.equal(f.owner.execution_arn.S,f.row.execution_arn.S);if(options.changeAppAtDescribe)assert.equal(f.app.nested.unknown,'outside-change');}
});
test('the fixed internal-auth stage uses only builtin tools and rejects other projects',()=>{
 const {setup}=require('../../infra/db-maintenance/runtime/setup-job.cjs'),f=fixture(),calls=[];setup(f.args.env,(...args)=>calls.push(args));assert.deepEqual(calls,[]);
 assert.throws(()=>setup({...f.args.env,CODEBUILD_BUILD_ARN:f.args.env.CODEBUILD_BUILD_ARN.replace('rotation-prod','smoke-prod')},()=>{}),/INVALID_SETUP_STAGE/);
});
test('local/GitHub and wrong-project contexts cannot reach production parameters',async()=>{
 const f=fixture();for(const change of [{GITHUB_ACTIONS:'true'},{VIDEOQ_CUTOVER_FINAL_HANDOFF:'false'},{CODEBUILD_BUILD_ARN:f.args.env.CODEBUILD_BUILD_ARN.replace('rotation-prod','smoke-prod')}])await assert.rejects(()=>provisionInternalAuth({...f.args,env:{...f.args.env,...change},aws:()=>{throw Error('unexpected AWS');},readParameter:()=>{throw Error('unexpected parameter');}}),/FIXED_AWS_INTERNAL_AUTH_REQUIRED/);
});
