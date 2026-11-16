const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceSmokeProof}=require('./d1-resource-smoke-proof.cjs');
const run='a'.repeat(32),source='b'.repeat(40),arn='arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:11111111-1111-1111-1111-111111111111';
function fixture(){
 const variables={MAINTENANCE_TABLE:'videoq-db-maintenance-prod',VIDEOQ_D1_PRODUCTION_SMOKE:'true'},rows=value=>Object.entries(value).map(([name,value])=>({name,value,type:'PLAINTEXT'}));
 const project={name:'videoq-db-smoke-prod',source:{type:'S3',location:'private-operator-bundle/operator.zip',buildspec:'reviewed-fixed-buildspec'},sourceVersion:'immutable-version',serviceRole:'fixed-role',concurrentBuildLimit:1,tags:[{key:'ReviewedSource',value:source}],environment:{type:'LINUX_CONTAINER',image:'fixed-image',environmentVariables:rows(variables)}};
 const build={arn,projectName:project.name,source:structuredClone(project.source),sourceVersion:project.sourceVersion,serviceRole:project.serviceRole,buildComplete:true,buildStatus:'SUCCEEDED',startTime:'2026-11-17T00:10:00Z',endTime:'2026-11-17T00:15:00Z',environment:{type:'LINUX_CONTAINER',image:'fixed-image',environmentVariables:rows({...variables,MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_STAGE:'smoke',MAINTENANCE_KIND:'smoke',VERIFY_AI_ANSWERS:'true',VIDEOQ_D1_RESOURCE_SMOKE:'true'})}};
 let owned=true;const calls=[];
 const proof=createResourceSmokeProof({run,source,assertExecutor:async()=>{if(!owned)throw Error('RESOURCE_EXECUTOR_LOST');},aws:async(service,command,input)=>{calls.push(command);assert.equal(service,'codebuild');if(command==='BatchGetProjects')return{projects:[structuredClone(project)]};assert.equal(command,'BatchGetBuilds');assert.deepEqual(input.ids,[arn]);return{builds:[structuredClone(build)]};}});
 return{project,build,calls,proof,revoke:()=>owned=false};
}
test('native proof is bound to reviewed immutable code, scope, AI verification and post-resume time',async()=>{
 const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z'),result=await f.proof.verify(plan,arn);assert.equal(result.receipt.verifyAiAnswers,true);assert.equal(result.receipt.source,source);assert.equal(result.receipt.buildArn,arn);assert.equal(result.receiptSha256.length,64);assert.ok(f.calls.every(name=>['BatchGetProjects','BatchGetBuilds'].includes(name)));
});
test('successful builds cannot override code, buildspec, role, image, source or run identity',async()=>{
 for(const mutate of [f=>f.build.sourceVersion='other',f=>f.build.source.buildspec='unreviewed',f=>f.build.serviceRole='other',f=>f.build.environment.image='other',f=>f.build.environment.environmentVariables.find(v=>v.name==='MAINTENANCE_RUN_ID').value='c'.repeat(32),f=>f.build.environment.environmentVariables.find(v=>v.name==='VERIFY_AI_ANSWERS').value='false']){const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z');mutate(f);await assert.rejects(f.proof.verify(plan,arn));}
});
test('stale, incomplete or failed builds cannot attest completion',async()=>{
 for(const mutate of [f=>f.build.startTime='2026-11-16T00:00:00Z',f=>f.build.buildComplete=false,f=>f.build.buildStatus='FAILED',f=>f.build.endTime='invalid']){const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z');mutate(f);await assert.rejects(f.proof.verify(plan,arn),/SUCCESSFUL_BUILD/);}
});
test('changed project review or revoked executor refuses the proof',async()=>{
 const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:00:00Z');f.project.tags[0].value='d'.repeat(40);await assert.rejects(f.proof.verify(plan,arn),/REVIEWED_PROJECT/);f.revoke();await assert.rejects(f.proof.verify(plan,arn),/EXECUTOR_LOST/);
});
test('AWS SDK Date timestamps keep subsecond freshness at the resume boundary',async()=>{
 const f=fixture(),plan=await f.proof.prepare('2026-11-17T00:10:00.250Z');f.build.startTime=new Date('2026-11-17T00:10:00.500Z');f.build.endTime=new Date('2026-11-17T00:15:00.750Z');const proof=await f.proof.verify(plan,arn);assert.equal(proof.receipt.startedAt,'2026-11-17T00:10:00.500Z');assert.equal(proof.receipt.completedAt,'2026-11-17T00:15:00.750Z');
});
