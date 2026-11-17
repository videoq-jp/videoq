const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceSmokeLauncher}=require('./d1-resource-smoke-launcher.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
const run='a'.repeat(32),source='b'.repeat(40),executorSha256='e'.repeat(64),arn='arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:11111111-1111-1111-1111-111111111111';
function fixture(options={}){
 const plan={nativePlan:{actionId:'c'.repeat(32),sourceVersion:'immutable',notBefore:'2026-11-17T00:00:00Z'}},calls=[],steps=[];
 let row={execution_arn:{S:'arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run},source_sha:{S:source},kind:{S:'d1-resource-hold'},resource_phase:{S:'holding'},release_requested:{BOOL:false},resource_executor_sha256:{S:executorSha256},resource_revision:{N:'1'}},build,owned=true;
 const input={projectName:'videoq-db-smoke-prod',sourceVersion:'immutable',idempotencyToken:plan.nativePlan.actionId,environmentVariablesOverride:[{name:'VIDEOQ_D1_RESOURCE_ACTION_ID',value:plan.nativePlan.actionId,type:'PLAINTEXT'},{name:'VIDEOQ_D1_RESOURCE_PLAN_SHA256',value:resourceDigest(plan),type:'PLAINTEXT'}]};
 const journal={assertExecutor:async()=>{if(!owned)throw Error('RESOURCE_EXECUTOR_LOST');},assertPending:async p=>assert.deepEqual(p,{step:'verify-e2e',planSha256:resourceDigest(plan)}),inspect:async()=>({steps:[{step:'verify-e2e',state:'verified',planSha256:resourceDigest(plan)}]})};
 const proof={launchInput:async()=>structuredClone(input),status:async()=>({state:'pending'}),matchesBuild:async(_plan,buildArn)=>buildArn===arn&&build?.sourceVersion===input.sourceVersion&&input.environmentVariablesOverride.every(v=>build.environment.environmentVariables.some(w=>resourceDigest(v)===resourceDigest(w)))};
 const aws=async(service,command,arg)=>{
  calls.push({service,command,arg});
  if(command==='GetItem')return{Item:structuredClone(row)};
  if(command==='TransactWriteItems'){
   const update=arg.TransactItems[0].Update,v=update.ExpressionAttributeValues;assert.equal(arg.TransactItems[1].ConditionCheck.Key.pk.S,'maintenance');assert.equal(v[':previous'].N,row.resource_revision.N);assert.match(update.ConditionExpression,/resource_executor_sha256=:executor/);
   row={...row,resource_revision:v[':next'],resource_smoke_action_id:v[':action'],resource_smoke_plan_sha256:v[':plan'],resource_smoke_source_version:v[':version'],resource_smoke_state:v[':starting'],...(v[':build']?{resource_smoke_build_arn:v[':build']}:{})};steps.push(v[':build']?'registered':'intent');
   if(options.lostWrite)throw Error('sensitive AWS error');return{};
  }
  if(command==='StartBuild'){
   assert.equal(steps.at(-1),'intent');assert.deepEqual(arg,input);steps.push('start');
   build={arn,projectName:input.projectName,sourceVersion:input.sourceVersion,startTime:new Date('2026-11-17T00:01:00Z'),environment:{environmentVariables:structuredClone(input.environmentVariablesOverride)}};
   if(options.revokeOnStart)owned=false;
   if(options.lostStart)throw Error('sensitive start response');return{build:{arn}};
  }
  if(command==='BatchGetBuilds')return{builds:build?[structuredClone(build)]:[]};
  if(command==='ListBuildsForProject'){
   assert.equal(Object.hasOwn(arg,'sortOrder'),false);
   if(options.pages){if(!arg.nextToken)return{ids:Array.from({length:100},(_,i)=>'videoq-db-smoke-prod:00000000-0000-0000-0000-'+String(i).padStart(12,'0')),nextToken:'second'};assert.equal(arg.nextToken,'second');return{ids:[arn]};}
   return{ids:build?[arn]:[],...(options.paginationLoop?{nextToken:'repeat'}:{})};
  }
  throw Error('Unexpected '+command);
 };
 const launcher=createResourceSmokeLauncher({aws,journal,proof,run,source,executorSha256,enabled:options.enabled!==false});
 return{launcher,plan,calls,steps,get row(){return row;},get build(){return build;},revoke:()=>owned=false};
}
test('one native attempt persists intent before start and registers accepted ARN; reentry never starts again',async()=>{
 const f=fixture();assert.deepEqual(await f.launcher.advance(f.plan),{buildArn:arn,pending:true});assert.deepEqual(f.steps,['intent','start','registered']);await f.launcher.advance(f.plan);assert.equal(f.calls.filter(c=>c.command==='StartBuild').length,1);
});
test('lost StartBuild response reconciles exact action metadata without repeating the request',async()=>{
 const f=fixture({lostStart:true});await assert.rejects(f.launcher.advance(f.plan),/START_RECONCILIATION/);assert.equal(f.row.resource_smoke_build_arn,undefined);assert.deepEqual(await f.launcher.advance(f.plan),{buildArn:arn,pending:true});assert.equal(f.calls.filter(c=>c.command==='StartBuild').length,1);
});
test('lost durable DDB responses are reconciled by exact readback',async()=>{
 const f=fixture({lostWrite:true});await f.launcher.advance(f.plan);assert.equal(f.row.resource_smoke_build_arn.S,arn);
});
test('ambiguous attempt with no matching build cannot automatically restart',async()=>{
 const f=fixture({lostStart:true});await assert.rejects(f.launcher.advance(f.plan));f.build.environment.environmentVariables[0].value='other';await assert.rejects(f.launcher.advance(f.plan),/START_RECONCILIATION/);assert.equal(f.calls.filter(c=>c.command==='StartBuild').length,1);
});
test('registered build metadata drift and ownership loss fail closed',async()=>{
 const f=fixture();await f.launcher.advance(f.plan);f.build.sourceVersion='changed';await assert.rejects(f.launcher.advance(f.plan),/REGISTERED_BUILD_CHANGED/);
 const g=fixture({revokeOnStart:true});await assert.rejects(g.launcher.advance(g.plan),/EXECUTOR_LOST/);assert.equal(g.row.resource_smoke_build_arn,undefined);
});
test('disabled launcher and changed action refuse mutation; incomplete inventory cannot register',async()=>{
 const f=fixture({enabled:false});await assert.rejects(f.launcher.advance(f.plan),/DISABLED/);assert.equal(f.calls.length,0);
 const g=fixture();await g.launcher.advance(g.plan);g.row.resource_smoke_action_id.S='d'.repeat(32);await assert.rejects(g.launcher.advance(g.plan),/ACTION_CHANGED/);
 const h=fixture({lostStart:true,paginationLoop:true});await assert.rejects(h.launcher.advance(h.plan));await assert.rejects(h.launcher.advance(h.plan),/INVENTORY_INCOMPLETE/);assert.equal(h.row.resource_smoke_build_arn,undefined);
});

test('read-only observation waits for registration and completed journal can locate owned build',async()=>{
 const f=fixture();assert.deepEqual(await f.launcher.observe(f.plan),{state:'not-started'});assert.equal(f.calls.filter(c=>c.command==='StartBuild').length,0);
 await f.launcher.advance(f.plan);const count=f.calls.filter(c=>c.command==='TransactWriteItems').length;assert.deepEqual(await f.launcher.observe(f.plan),{state:'pending'});assert.equal(await f.launcher.readBuild(f.plan),arn);assert.equal(f.calls.filter(c=>c.command==='TransactWriteItems').length,count);
});

test('ambiguous start is reconciled beyond 100 builds using provider-compatible un-sorted pagination',async()=>{
 const f=fixture({lostStart:true,pages:true});await assert.rejects(f.launcher.advance(f.plan),/START_RECONCILIATION/);assert.equal((await f.launcher.advance(f.plan)).buildArn,arn);const pages=f.calls.filter(c=>c.command==='ListBuildsForProject');assert.equal(pages.length,2);assert.equal(pages[0].arg.nextToken,undefined);assert.equal(pages[1].arg.nextToken,'second');assert.equal(f.calls.filter(c=>c.command==='StartBuild').length,1);
});
