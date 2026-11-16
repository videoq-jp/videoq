'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash,randomUUID}=require('node:crypto');
const {reconcileLegacyD1Alias,LEGACY_SOURCE}=require('./cutover-d1-alias-reconcile.cjs');
const {rawApiFingerprint,apiFingerprint,desiredEnvironment}=require('./cutover-backend-handoff.cjs');
const {TARGET}=require('./cutover-final-context.cjs');
const sha=v=>createHash('sha256').update(v).digest('hex');
function fixture(options={}){
 const run='a'.repeat(32),source=LEGACY_SOURCE,operatorSource='c'.repeat(40),version=randomUUID(),authVersion=randomUUID();
 const base={bindings:[{name:'DB',type:'d1',id:TARGET.databaseId},{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'PERSISTENCE_BACKEND',type:'plain_text',text:'d1'},{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:TARGET.largeIndex},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:TARGET.smallIndex},{name:'WORKER_INTERNAL_API_SECRET',type:'secret_text'},{name:'BETTER_AUTH_SECRET',type:'secret_text'},{name:'UNCHANGED',type:'plain_text',text:'preserve'}]};
 const original={APP_PARAM_NAME:'/videoq/prod/app',DB_PARAM_NAME:'/videoq/prod/worker-db',UNCHANGED:'preserve'};
 const intended=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'].map(name=>({name,revision:randomUUID(),codeSha256:'original-code',original:{...original},desired:desiredEnvironment(original)}));
 const profiles=intended.map(p=>({FunctionName:p.name,FunctionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+p.name,PackageType:'Image',State:'Active',LastUpdateStatus:'Successful',RevisionId:randomUUID(),CodeSha256:p.codeSha256,Environment:{Variables:structuredClone(p.desired)}}));
 const settings=structuredClone(base);settings.bindings[0].database_id=TARGET.databaseId;
 const row={execution_arn:{S:'synthetic-owned-execution'},source_sha:{S:source},cutover_revision:{N:'4'},database_mutations_started:{BOOL:true},release_requested:{BOOL:false}};
 for(const [key,value]of Object.entries({backend_handoff_intent:{version:1,runId:run,sourceSha:source,apiBeforeVersion:authVersion,apiBefore:'d'.repeat(64),apiAfter:rawApiFingerprint(base),profiles:intended},transfer_verify_receipt:{version:1,runId:run,sourceSha:source,phase:'verify',complete:true,target:TARGET},internal_auth_receipt:{version:1,runId:run,sourceSha:source,apiVersion:authVersion,admissionPaused:true,workerProfilesChanged:false,apiBackendChanged:false}})){const text=JSON.stringify(value);row[key]={S:text};row[key+'_sha256']={S:sha(text)};}
 let owner=true,writes=0;
 const args={run,source,operatorSource,verifyContext:async o=>{assert.equal(o.source,LEGACY_SOURCE);assert.equal(o.expectedBackend,'d1');if(!owner)throw Error('SYNTHETIC_OWNER_LOST');return{row:structuredClone(row)};},aws:async(service,command,input)=>{
  if(service==='lambda'){assert.equal(command,'GetFunctionConfiguration');return structuredClone(profiles.find(v=>v.FunctionName===input.FunctionName));}
  assert.equal(service,'ddb');if(command==='GetItem')return{Item:structuredClone(row)};
  assert.equal(command,'TransactWriteItems');assert.ok(owner);if(options.ownerLost){owner=false;throw Error('SYNTHETIC_OWNER_LOST');}
  const update=input.TransactItems[0].Update,v=update.ExpressionAttributeValues,n=update.ExpressionAttributeNames;
  assert.match(update.ConditionExpression,/database_mutations_started=:true/);assert.match(update.ConditionExpression,/attribute_not_exists\(backend_handoff_receipt\)/);assert.match(update.ConditionExpression,/backend_handoff_intent=:intent/);assert.equal(v[':source'].S,LEGACY_SOURCE);assert.equal(v[':previous'].N,row.cutover_revision.N);assert.equal(input.TransactItems[1].ConditionCheck.ExpressionAttributeValues[':kind'].S,'cutover-hold');
  Object.entries(n).filter(([key])=>key.startsWith('#f')).forEach(([key,name])=>{row[name]=v[':f'+key.slice(2)];});row.cutover_revision=v[':next'];writes++;if(options.lostResponse)throw Error('SYNTHETIC_LOST_RESPONSE');return{};
 },cloudflare:async(method,path)=>{assert.equal(method,'GET');if(path.endsWith('/deployments'))return{deployments:[{versions:[{version_id:version,percentage:100}]}]};if(path.includes('/versions?'))return{items:[{id:version}]};return structuredClone(settings);}};
 return{args,row,settings,profiles,get writes(){return writes;}};
}
test('legacy reconciliation records observed raw identity for the pinned old finalizer without runtime writes',async()=>{
 const f=fixture();assert.deepEqual(await reconcileLegacyD1Alias(f.args),{reconciled:true,admissionPaused:true,productionSafe:false});
 const receipt=JSON.parse(f.row.backend_handoff_receipt.S),audit=JSON.parse(f.row.backend_alias_reconciliation_receipt.S);
 assert.equal(receipt.sourceSha,LEGACY_SOURCE);assert.equal(receipt.apiBindingsSha256,rawApiFingerprint(f.settings));assert.notEqual(receipt.apiBindingsSha256,apiFingerprint(f.settings));assert.equal(audit.intendedApiBindingsSha256,apiFingerprint(f.settings));assert.equal(audit.runtimeConfigurationChanged,false);assert.equal(audit.admissionChanged,false);assert.equal(f.writes,1);
 await reconcileLegacyD1Alias(f.args);assert.equal(f.writes,1);assert.equal(f.row.database_mutations_started.BOOL,true);assert.equal(f.row.release_requested.BOOL,false);
});
test('lost successful metadata response is reconciled by durable readback',async()=>{const f=fixture({lostResponse:true});await reconcileLegacyD1Alias(f.args);assert.equal(f.writes,1);assert.ok(f.row.backend_alias_reconciliation_receipt);});
test('mismatched alias, extra metadata, wrong target, changed code and unrelated environment refuse completion',async()=>{
 const changes=[f=>{f.settings.bindings[0].database_id='other';},f=>{f.settings.bindings[0].unexpected='outside';},f=>{f.settings.bindings[0].id=f.settings.bindings[0].database_id='other';},f=>{f.profiles[0].CodeSha256='changed';},f=>{f.profiles[0].Environment.Variables.UNCHANGED='outside';},f=>{f.settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE').text='running';},f=>{f.row.internal_auth_receipt_sha256.S='bad';}];
 for(const change of changes){const f=fixture();change(f);await assert.rejects(()=>reconcileLegacyD1Alias(f.args));assert.equal(f.writes,0);assert.equal(f.row.backend_handoff_receipt,undefined);}
});
test('owner loss and unsupported legacy source cannot record success',async()=>{
 const f=fixture({ownerLost:true});await assert.rejects(()=>reconcileLegacyD1Alias(f.args));assert.equal(f.writes,0);
 const wrong=fixture();wrong.args.source='d'.repeat(40);await assert.rejects(()=>reconcileLegacyD1Alias(wrong.args),/FIXED_LEGACY_HANDOFF_REQUIRED/);assert.equal(wrong.writes,0);
});
test('CLI verifies the new reviewed operator separately and refuses GitHub, bad source and wrong account',async()=>{
 const {main,parse}=require('./run-cutover-d1-alias-reconcile.cjs'),args=['--run','a'.repeat(32),'--hold-source',LEGACY_SOURCE,'--operator-source','c'.repeat(40)];let checks=0,ancestry=0;
 assert.equal(parse(args).source,LEGACY_SOURCE);assert.throws(()=>parse(['--run','a'.repeat(32),'--hold-source','d'.repeat(40),'--operator-source','c'.repeat(40)]));
 await assert.rejects(()=>main({args,env:{GITHUB_ACTIONS:'true'},verifySource:async()=>{checks++;}}));assert.equal(checks,0);
 await assert.rejects(()=>main({args,env:{},verifySource:async({source})=>{checks++;assert.equal(source,'c'.repeat(40));},execute:(_c,a)=>{assert.deepEqual(a,['merge-base','--is-ancestor',LEGACY_SOURCE,'c'.repeat(40)]);ancestry++;},aws:async()=>({Account:'wrong'})}),/FIXED_RECONCILIATION_ACCOUNT_REQUIRED/);
 assert.equal(checks,1);assert.equal(ancestry,1);
});
