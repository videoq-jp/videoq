const {test}=require('node:test'),assert=require('node:assert/strict');
const {controlConsumers,publicApiState}=require('./cutover-consumer-control.cjs');
test('the mutating parent refuses missing feature/job context before AWS or secret access',async()=>{
 let calls=0;await assert.rejects(controlConsumers({env:{},aws:()=>{calls++;},readParameter:()=>{calls++;}}),/CONTEXT_REQUIRED/);assert.equal(calls,0);
});
test('backend receipts use only selected public bindings and reject ambiguous or invalid selectors',()=>{
 const settings={bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'HYPERDRIVE',type:'hyperdrive',id:'owned'}, {name:'PRIVATE',type:'secret_text'}]};
 assert.equal(publicApiState(settings).serialized.includes('PRIVATE'),false);
 for(const change of [s=>s.bindings.push({name:'ENVIRONMENT',type:'plain_text',text:'production'}),s=>s.bindings.push({name:'DEPLOYMENT_EDITION',type:'plain_text',text:'onprem'}),s=>s.bindings.push({name:'PERSISTENCE_BACKEND',type:'plain_text',text:'d1'})]){const copy=structuredClone(settings);change(copy);assert.throws(()=>publicApiState(copy),/API_STATE/);}
});
test('pause/resume stages use built-in operator tooling without application dependency installation',()=>{
 const {setup}=require('../../infra/db-maintenance/runtime/setup-job.cjs');
 for(const stage of ['cutover-consumer-pause','cutover-consumer-resume']){const calls=[];setup({CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:11111111-2222-4333-8444-555555555555',MAINTENANCE_STAGE:stage},(...args)=>calls.push(args));assert.deepEqual(calls,[]);}
});
