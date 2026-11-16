'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {handoffBackend,desiredEnvironment,desiredBindings}=require('./cutover-backend-handoff.cjs');
const {TARGET}=require('./cutover-final-context.cjs');
const sha=v=>createHash('sha256').update(v).digest('hex');
function fixture(options={}){
 const run='a'.repeat(32),source='b'.repeat(40),version=randomUUID();
 const row={execution_arn:{S:'synthetic-owned-execution'},source_sha:{S:source},cutover_revision:{N:'4'}};
 for(const [field,receipt]of Object.entries({transfer_verify_receipt:{version:1,runId:run,sourceSha:source,target:TARGET,complete:true,phase:'verify'},internal_auth_receipt:{version:1,runId:run,sourceSha:source,admissionPaused:true,workerProfilesChanged:false,apiBackendChanged:false,apiVersion:version}})){const text=JSON.stringify(receipt);row[field]={S:text};row[field+'_sha256']={S:sha(text)};}
 const profiles=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'].map(name=>({FunctionName:name,FunctionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+name,RevisionId:randomUUID(),CodeSha256:'original-code',State:'Active',LastUpdateStatus:'Successful',PackageType:'Image',Environment:{Variables:{APP_PARAM_NAME:'/videoq/prod/app',DB_PARAM_NAME:'/videoq/prod/worker-db',UNCHANGED:'preserve'}}}));
 let owner=true,writes=0,apiWrites=0,proofs=0;
 const settings={bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'},{name:'HYPERDRIVE',type:'hyperdrive',id:'original-neon'},{name:'BETTER_AUTH_SECRET',type:'secret_text'},{name:'WORKER_INTERNAL_API_SECRET',type:'secret_text'},{name:'UNCHANGED',type:'plain_text',text:'preserve'}]};
 const args={run,source,sleep:async()=>{},verifyContext:async({expectedBackend})=>{proofs++;if(!owner||settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text!=='paused')throw Error('SYNTHETIC_OWNER_OR_ADMISSION_LOSS');assert.equal(settings.bindings.find(v=>v.name==='PERSISTENCE_BACKEND')?.text??'postgres',expectedBackend);return{row:structuredClone(row)};},aws:async(service,command,input)=>{
  if(service==='ddb'){
   if(command==='GetItem')return{Item:structuredClone(row)};
   assert.equal(command,'TransactWriteItems');const update=input.TransactItems[0].Update,v=update.ExpressionAttributeValues,n=update.ExpressionAttributeNames;
   assert.match(update.ConditionExpression,/database_mutations_started=:true/);assert.match(update.ConditionExpression,/postgres_fence_state=:fenced/);assert.equal(input.TransactItems[1].ConditionCheck.ExpressionAttributeValues[':kind'].S,'cutover-hold');assert.ok(owner);assert.equal(v[':previous'].N,row.cutover_revision.N);
   if(options.ownerLostAtIntent){owner=false;throw Error('SYNTHETIC_OWNER_LOST');}
   row[n['#field']]=v[':value'];row[n['#sha']]=v[':sha'];row.cutover_revision=v[':next'];if(options.lostIntentResponse&&n['#field']==='backend_handoff_intent')throw Error('SYNTHETIC_LOST_RESPONSE');return{};
  }
  assert.equal(service,'lambda');const item=profiles.find(v=>v.FunctionName===input.FunctionName);assert.ok(item);
  if(command==='GetFunctionConfiguration')return structuredClone(item);
  assert.equal(command,'UpdateFunctionConfiguration');assert.ok(row.backend_handoff_intent);assert.equal(input.RevisionId,item.RevisionId);item.Environment=structuredClone(input.Environment);item.RevisionId=randomUUID();writes++;
  if(options.outsideProfileChange){item.Environment.Variables.UNCHANGED='outside';throw Error('SYNTHETIC_OUTSIDE_CHANGE');}
  if(options.lostProfileResponse)throw Error('SYNTHETIC_LOST_RESPONSE');return structuredClone(item);
 },cloudflare:async(method,path,input)=>{
  if(path.endsWith('/deployments'))return{deployments:[{versions:[{version_id:version,percentage:100}]}]};
  if(path.includes('/versions?'))return{items:[{id:version}]};
  if(method==='GET')return structuredClone(settings);
  assert.equal(method,'PATCH');assert.equal(writes,3);assert.ok(row.backend_handoff_intent);const previous=settings.bindings;settings.bindings=input.bindings.map(v=>v.type==='inherit'?previous.find(b=>b.name===v.name):v);apiWrites++;
  if(options.outsideApiChange)settings.bindings.find(v=>v.name==='UNCHANGED').text='outside';
  if(options.lostApiResponse)throw Error('SYNTHETIC_LOST_RESPONSE');return{};
 }};
 return{args,row,profiles,settings,get writes(){return writes;},get apiWrites(){return apiWrites;},get proofs(){return proofs;}};
}
test('serial handoff binds intent before changing fixed Lambda profiles and inherits all user secrets',async()=>{
 const f=fixture();assert.deepEqual(await handoffBackend(f.args),{backend:'d1',admissionPaused:true,productionSafe:false});assert.equal(f.writes,3);assert.equal(f.apiWrites,1);assert.ok(f.proofs>10);
 for(const p of f.profiles){assert.equal(p.Environment.Variables.UNCHANGED,'preserve');assert.equal(p.Environment.Variables.PERSISTENCE_BACKEND,'d1');assert.equal(p.Environment.Variables.WORKER_INTERNAL_API_ORIGIN,'https://videoq.jp');assert.equal(p.Environment.Variables.DB_PARAM_NAME,'/videoq/prod/worker-db');}
 assert.equal(f.settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text,'paused');assert.equal(f.settings.bindings.find(v=>v.name==='BETTER_AUTH_SECRET').type,'secret_text');assert.ok(!JSON.stringify(f.row).includes('secret value'));
 const count=f.writes;await handoffBackend(f.args);assert.equal(f.writes,count);assert.equal(f.apiWrites,1);
});
test('lost successful intent, profile and metadata responses reconcile by exact observation',async()=>{const f=fixture({lostIntentResponse:true,lostProfileResponse:true,lostApiResponse:true});await handoffBackend(f.args);assert.ok(f.row.backend_handoff_receipt);});
test('owner loss and unrelated profile/API changes leave admission closed without a success receipt',async()=>{
 for(const options of [{ownerLostAtIntent:true},{outsideProfileChange:true},{outsideApiChange:true}]){const f=fixture(options);await assert.rejects(()=>handoffBackend(f.args));assert.equal(f.row.backend_handoff_receipt,undefined);assert.equal(f.settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text,'paused');}
});
test('inline secrets and ambiguous/unpaused API settings cannot enter a durable handoff intent',()=>{
 assert.throws(()=>desiredEnvironment({APP_PARAM_NAME:'/videoq/prod/app',DB_PARAM_NAME:'/videoq/prod/worker-db',DATABASE_URL:'must-not-be-persisted'}));assert.throws(()=>desiredBindings({bindings:[]}));
});
test('local CLI rejects GitHub and wrong-account contexts before any configuration write',async()=>{
 const {main}=require('./run-cutover-backend.cjs');let calls=0;
 await assert.rejects(()=>main({args:['--run','a'.repeat(32),'--source','b'.repeat(40)],env:{GITHUB_ACTIONS:'true'},verifySource:async()=>{calls++;}}));assert.equal(calls,0);
 await assert.rejects(()=>main({args:['--run','a'.repeat(32),'--source','b'.repeat(40)],env:{},verifySource:async()=>{},aws:async()=>({Account:'wrong'})}),/FIXED_HANDOFF_ACCOUNT_REQUIRED/);
});
test('extra handoff AWS transport scopes mutations to the fixed workers and keeps metadata transport unprivileged',async()=>{
 const {createHandoffAwsTransport}=require('./cutover-handoff-aws.cjs');let calls=0;
 const aws=createHandoffAwsTransport({env:{PATH:process.env.PATH,HOME:process.env.HOME,CLOUDFLARE_API_TOKEN:'must-not-forward',GH_TOKEN:'must-not-forward'},execute:(_command,_args,options)=>{calls++;assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(options.env.GH_TOKEN,undefined);assert.equal(options.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS,'true');return '{}';}});
 await assert.rejects(()=>aws('lambda','UpdateFunctionConfiguration',{FunctionName:'other-worker',RevisionId:'r',Environment:{Variables:{}}}));await assert.rejects(()=>aws('scheduler','GetSchedule',{Name:'other-schedule',GroupName:'default'}));await assert.rejects(()=>aws('lambda','UpdateEventSourceMapping',{UUID:randomUUID(),Enabled:true,FunctionName:'other'}));await assert.rejects(()=>aws('ssm','GetParameter',{Name:'/videoq/security/prod/db-admin'}));assert.equal(calls,0);
 await aws('lambda','UpdateFunctionConfiguration',{FunctionName:'videoq-worker-prod',RevisionId:'r',Environment:{Variables:{PERSISTENCE_BACKEND:'d1'}}});assert.equal(calls,1);
});
