const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceSmokeProof}=require('./d1-resource-smoke-proof.cjs');
const run='a'.repeat(32),source='b'.repeat(40),arn='arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:11111111-1111-1111-1111-111111111111';
function fixture(){
 const variables={MAINTENANCE_TABLE:'videoq-db-maintenance-prod',VIDEOQ_D1_PRODUCTION_SMOKE:'true'},rows=value=>Object.entries(value).map(([name,value])=>({name,value,type:'PLAINTEXT'}));
 const project={name:'videoq-db-smoke-prod',source:{type:'S3',location:'private-operator-bundle/operator.zip',buildspec:'reviewed-fixed-buildspec'},sourceVersion:'immutable-version',serviceRole:'fixed-role',concurrentBuildLimit:1,tags:[{key:'ReviewedSource',value:source}],environment:{type:'LINUX_CONTAINER',image:'fixed-image',environmentVariables:rows(variables)}};
 const build={arn,projectName:project.name,source:structuredClone(project.source),sourceVersion:project.sourceVersion,serviceRole:project.serviceRole,buildComplete:true,buildStatus:'SUCCEEDED',startTime:'2026-11-17T00:10:00Z',endTime:'2026-11-17T00:15:00Z',environment:{type:'LINUX_CONTAINER',image:'fixed-image',environmentVariables:rows({...variables,MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_STAGE:'smoke',MAINTENANCE_KIND:'smoke',VERIFY_AI_ANSWERS:'true',VIDEOQ_D1_RESOURCE_SMOKE:'true',VIDEOQ_D1_RESOURCE_ACTION_ID:'0'.repeat(32),VIDEOQ_D1_RESOURCE_PLAN_SHA256:'d'.repeat(64),VIDEOQ_D1_RESOURCE_EXECUTOR_SHA256:'e'.repeat(64),VIDEOQ_D1_RESOURCE_DEFINITION_SHA256:'f'.repeat(64)})}};
 let owned=true;const calls=[];
 const proof=createResourceSmokeProof({run,source,executorSha256:'e'.repeat(64),definitionSha256:'f'.repeat(64),assertExecutor:async()=>{if(!owned)throw Error('RESOURCE_EXECUTOR_LOST');},aws:async(service,command,input)=>{calls.push(command);assert.equal(service,'codebuild');if(command==='BatchGetProjects')return{projects:[structuredClone(project)]};assert.equal(command,'BatchGetBuilds');assert.deepEqual(input.ids,[arn]);return{builds:[structuredClone(build)]};}});
 const prepared=proof.prepare.bind(proof);proof.prepare=async value=>{const plan=await prepared(value);build.environment.environmentVariables.find(v=>v.name==='VIDEOQ_D1_RESOURCE_ACTION_ID').value=plan.actionId;return plan;};
 return{project,build,calls,proof,revoke:()=>owned=false};
}
test('native proof is bound to reviewed immutable code, scope, AI verification and post-resume time',async()=>{
 const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z'),result=await f.proof.verify(plan,arn,'d'.repeat(64));assert.equal(result.receipt.verifyAiAnswers,true);assert.equal(result.receipt.source,source);assert.equal(result.receipt.buildArn,arn);assert.equal(result.receiptSha256.length,64);assert.ok(f.calls.every(name=>['BatchGetProjects','BatchGetBuilds'].includes(name)));
});
test('successful builds cannot override code, buildspec, role, image, source or run identity',async()=>{
 for(const mutate of [f=>f.build.sourceVersion='other',f=>f.build.source.buildspec='unreviewed',f=>f.build.serviceRole='other',f=>f.build.environment.image='other',f=>f.build.environment.environmentVariables.find(v=>v.name==='MAINTENANCE_RUN_ID').value='c'.repeat(32),f=>f.build.environment.environmentVariables.find(v=>v.name==='VERIFY_AI_ANSWERS').value='false']){const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z');mutate(f);await assert.rejects(f.proof.verify(plan,arn,'d'.repeat(64)));}
});
test('stale, incomplete or failed builds cannot attest completion',async()=>{
 for(const mutate of [f=>f.build.startTime='2026-11-16T00:00:00Z',f=>f.build.buildComplete=false,f=>f.build.buildStatus='FAILED',f=>f.build.endTime='invalid']){const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z');mutate(f);await assert.rejects(f.proof.verify(plan,arn,'d'.repeat(64)),/SUCCESSFUL_BUILD/);}
});
test('changed project review or revoked executor refuses the proof',async()=>{
 const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z');f.project.tags[0].value='d'.repeat(40);await assert.rejects(f.proof.verify(plan,arn,'d'.repeat(64)),/REVIEWED_PROJECT/);f.revoke();await assert.rejects(f.proof.verify(plan,arn,'d'.repeat(64)),/EXECUTOR_LOST/);
});
test('AWS SDK Date timestamps keep subsecond freshness at the resume boundary',async()=>{
 const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:10:00.250Z');f.build.startTime=new Date('2026-11-17T00:10:00.500Z');f.build.endTime=new Date('2026-11-17T00:15:00.750Z');const proof=await f.proof.verify(plan,arn,'d'.repeat(64));assert.equal(proof.receipt.startedAt,'2026-11-17T00:10:00.500Z');assert.equal(proof.receipt.completedAt,'2026-11-17T00:15:00.750Z');
});
test('owned launch input pins immutable source and only the fixed metadata overrides',async()=>{
 const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z'),input=await f.proof.launchInput(plan,'d'.repeat(64));
 assert.deepEqual(Object.keys(input).sort(),['environmentVariablesOverride','idempotencyToken','projectName','sourceVersion']);assert.equal(input.idempotencyToken,plan.actionId);assert.equal(input.sourceVersion,plan.sourceVersion);assert.equal(input.projectName,'videoq-db-smoke-prod');assert.equal(input.environmentVariablesOverride.length,10);assert.ok(input.environmentVariablesOverride.every(v=>v.type==='PLAINTEXT'));assert.equal(input.environmentVariablesOverride.find(v=>v.name==='VIDEOQ_D1_RESOURCE_PLAN_SHA256').value,'d'.repeat(64));
 f.project.sourceVersion='new-version';await assert.rejects(f.proof.launchInput(plan,'d'.repeat(64)),/PROJECT_CHANGED/);
});
test('running build reconciliation requires exact reviewed role, runtime and complete environment',async()=>{
 const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z');f.build.buildStatus='IN_PROGRESS';f.build.buildComplete=false;delete f.build.endTime;
 assert.equal(await f.proof.matchesBuild(plan,arn,'d'.repeat(64)),true);await assert.rejects(f.proof.verify(plan,arn,'d'.repeat(64)),/SUCCESSFUL_BUILD/);
 f.build.serviceRole='unreviewed-role';assert.equal(await f.proof.matchesBuild(plan,arn,'d'.repeat(64)),false);f.build.serviceRole=f.project.serviceRole;
 f.build.environment.environmentVariables.push({name:'UNREVIEWED',value:'yes',type:'PLAINTEXT'});assert.equal(await f.proof.matchesBuild(plan,arn,'d'.repeat(64)),false);
});
test('native build status distinguishes pending, failed and verified completion',async()=>{
 const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z');f.build.buildStatus='IN_PROGRESS';f.build.buildComplete=false;delete f.build.endTime;
 assert.deepEqual(await f.proof.status(plan,arn,'d'.repeat(64)),{state:'pending'});f.build.buildStatus='FAILED';f.build.buildComplete=true;f.build.endTime='2026-11-17T00:15:00Z';assert.deepEqual(await f.proof.status(plan,arn,'d'.repeat(64)),{state:'failed'});
 f.build.buildStatus='SUCCEEDED';assert.equal((await f.proof.status(plan,arn,'d'.repeat(64))).state,'succeeded');
});
