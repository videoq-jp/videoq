const {test}=require('node:test'),assert=require('node:assert/strict');
const {prepareConsumers}=require('./cutover-consumer-prepare.cjs');
test('consumer preparation refuses missing or forged job context before any AWS request',async()=>{
 let calls=0;
 await assert.rejects(prepareConsumers({env:{},aws:()=>{calls++;throw Error('must not call');}}),/CONTEXT_REQUIRED/);assert.equal(calls,0);
});
test('the fixed readonly stage installs no database or application dependencies',()=>{
 const {setup}=require('../../infra/db-maintenance/runtime/setup-job.cjs'),calls=[];
 setup({CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:11111111-2222-4333-8444-555555555555',MAINTENANCE_STAGE:'cutover-consumer-prepare'},(...args)=>calls.push(args));
 assert.deepEqual(calls,[]);
});
