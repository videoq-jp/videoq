const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceSmokeGuard}=require('./d1-resource-smoke-guard.cjs');
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const {runProductionSmoke}=require('./aws-production-smoke.cjs');
function fixture(){
 const run='a'.repeat(32),source='b'.repeat(40),hash='c'.repeat(64),spec={States:{Wait:{Type:'Wait',Seconds:10}}},arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
 const env={VIDEOQ_D1_RESOURCE_SMOKE:'true',VIDEOQ_D1_PRODUCTION_SMOKE:'true',VERIFY_AI_ANSWERS:'true',MAINTENANCE_KIND:'smoke',MAINTENANCE_STAGE:'smoke',MAINTENANCE_TABLE:'videoq-db-maintenance-prod',MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:source,VIDEOQ_D1_RESOURCE_ACTION_ID:'d'.repeat(32),VIDEOQ_D1_RESOURCE_PLAN_SHA256:hash,VIDEOQ_D1_RESOURCE_EXECUTOR_SHA256:hash,VIDEOQ_D1_RESOURCE_DEFINITION_SHA256:resourceDigest(spec),CODEBUILD_SOURCE_VERSION:'immutable-version',CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:11111111-1111-1111-1111-111111111111'};
 const index=RESOURCE_STEPS.indexOf('verify-e2e'),steps=RESOURCE_STEPS.slice(0,index+1).map((step,i)=>({step,state:i===index?'intent':'verified',planSha256:hash,...(i===index?{}:{receiptSha256:hash})}));
 const row={kind:{S:'d1-resource-hold'},execution_arn:{S:arn},source_sha:{S:source},resource_phase:{S:'holding'},release_requested:{BOOL:false},resource_executor_sha256:{S:hash},resource_steps:{S:JSON.stringify(steps)},resource_steps_sha256:{S:resourceDigest(steps)},resource_smoke_action_id:{S:env.VIDEOQ_D1_RESOURCE_ACTION_ID},resource_smoke_plan_sha256:{S:hash},resource_smoke_source_version:{S:env.CODEBUILD_SOURCE_VERSION},resource_smoke_build_arn:{S:env.CODEBUILD_BUILD_ARN}};
 let status='RUNNING';const owner={kind:{S:'d1-resource-hold'},execution_arn:{S:arn}},calls=[];
 const aws=async(service,command,input)=>{calls.push(command);if(service==='ddb'){assert.equal(command,'GetItem');return{Item:structuredClone(input.Key.pk.S==='maintenance'?owner:row)};}assert.equal(service,'sfn');return command==='DescribeExecution'?{status}:{definition:JSON.stringify(spec)};};
 return{env,row,owner,aws,calls,stop:()=>status='FAILED'};
}
test('disabled guard makes no metadata calls and active guard requires exact live ownership',async()=>{
 const f=fixture();await createResourceSmokeGuard({env:{}}).assert();await createResourceSmokeGuard({env:f.env,aws:f.aws}).assert();assert.deepEqual(new Set(f.calls),new Set(['GetItem','DescribeExecution','DescribeStateMachineForExecution']));
});
test('registration can settle before secret access but wrong registered build never waits',async()=>{
 const f=fixture();delete f.row.resource_smoke_build_arn;f.row.resource_smoke_state={S:'starting'};let sleeps=0;
 const guard=createResourceSmokeGuard({env:f.env,aws:f.aws,sleep:async()=>{sleeps++;f.row.resource_smoke_build_arn={S:f.env.CODEBUILD_BUILD_ARN};}});await guard.wait();assert.equal(sleeps,1);
 f.row.resource_smoke_build_arn={S:'other'};await assert.rejects(guard.wait(),/REGISTRATION/);
});
test('source, step, executor, action or terminal hold changes refuse native execution',async()=>{
 for(const mutate of [f=>f.row.source_sha.S='e'.repeat(40),f=>f.row.release_requested.BOOL=true,f=>f.row.resource_executor_sha256.S='e'.repeat(64),f=>f.row.resource_smoke_action_id.S='e'.repeat(32),f=>f.row.resource_smoke_source_version.S='other',f=>f.owner.execution_arn.S+='other',f=>f.stop()]){const f=fixture();mutate(f);await assert.rejects(createResourceSmokeGuard({env:f.env,aws:f.aws}).assert(),/LIVE_OWNERSHIP/);}
});
test('unregistered native build fails before SSM reads or child launch',async()=>{
 const f=fixture();f.row.resource_smoke_build_arn={S:'other'};let secrets=0,children=0;
 await assert.rejects(runProductionSmoke({env:f.env,metadataAws:f.aws,readParameter:()=>{secrets++;},execute:()=>{children++;}}),/REGISTRATION/);assert.equal(secrets,0);assert.equal(children,0);
});
test('registered D1 smoke rechecks ownership before credentials, launch and completion',async()=>{
 const f=fixture(),parameters=[],children=[];
 const result=await runProductionSmoke({env:f.env,metadataAws:f.aws,readParameter:name=>{parameters.push(name);return name.endsWith('d1-migration')?{CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'synthetic-token-0123456789'}:{key:'f'.repeat(64)};},fetcher:async()=>Response.json({success:true,result:{bindings:[{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'DB',type:'d1',id:'587bd210-6d9d-4f32-abb7-a490013e65d3'}]}}),execute:(...args)=>children.push(args)});
 assert.equal(result.backend,'d1');assert.equal(children.length,1);assert.deepEqual(parameters,['/videoq/security/prod/d1-migration','/videoq/security/prod/smoke-identity']);assert.ok(f.calls.length>=16);assert.equal(children[0][2].env.VIDEOQ_D1_RESOURCE_EXECUTOR_SHA256,undefined);
});
test('owned D1 smoke cannot fall back to the retired PostgreSQL credential path',async()=>{
 const f=fixture(),parameters=[];let children=0;
 await assert.rejects(runProductionSmoke({env:f.env,metadataAws:f.aws,readParameter:name=>{parameters.push(name);return{CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'synthetic-token-0123456789'};},fetcher:async()=>Response.json({success:true,result:{bindings:[]}}),execute:()=>{children++;}}),/D1_BACKEND_REQUIRED/);
 assert.deepEqual(parameters,['/videoq/security/prod/d1-migration']);assert.equal(children,0);
});
