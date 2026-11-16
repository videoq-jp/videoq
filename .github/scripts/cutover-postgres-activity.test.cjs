const {test}=require('node:test'),assert=require('node:assert/strict');
const {input,HOLD_KIND}=require('../../infra/db-maintenance/runtime/policy.cjs');
test('activity controls are maintenance metadata only and cannot carry commands or targets',()=>{
 for(const action of ['inspect-cutover-activity','retry-cutover-activity']){const value={action,run_id:'a'.repeat(32)};assert.deepEqual(input(value,[HOLD_KIND]),value);assert.throws(()=>input(value,['audit']),/NOT_ALLOWED/);for(const field of ['sql','source_sha','target','state','stage','project'])assert.throws(()=>input({...value,[field]:'override'},[HOLD_KIND]),/UNEXPECTED_INPUT/);}
});
test('the fixed readonly activity stage installs only locked operator tools',()=>{
 const {setup}=require('../../infra/db-maintenance/runtime/setup-job.cjs'),calls=[];setup({CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:11111111-2222-4333-8444-555555555555',MAINTENANCE_STAGE:'cutover-activity-audit'},(...args)=>calls.push(args));assert.deepEqual(calls,[['npm',['ci','--ignore-scripts','--prefix','.github/operations-tools']],['npm',['audit','signatures','--prefix','.github/operations-tools']]]);
});
test('the AWS activity parent refuses missing feature or stage context before transports or credentials',async()=>{
 const {runHeldPostgresActivity}=await import('./cutover-postgres-activity.mjs');let calls=0;await assert.rejects(runHeldPostgresActivity({env:{},aws:()=>{calls++;},readParameter:()=>{calls++;},ensureDependencies:()=>{calls++;}}),/CONTEXT/);assert.equal(calls,0);
});
