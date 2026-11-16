const {test}=require('node:test'),assert=require('node:assert/strict');
const {stageSucceeded,requireStageSucceeded}=require('../../infra/db-maintenance/runtime/stage-proof.cjs');
const arn='arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:11111111-2222-4333-8444-555555555555';
const row={execution_arn:{S:'arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+'a'.repeat(32)},cutover_last_build_arn:{S:arn}};
const succeeded=build=>({type:'TaskSucceeded',taskSucceededEventDetails:{resourceType:'codebuild',resource:'startBuild.sync',output:JSON.stringify({Build:{BuildStatus:'SUCCEEDED',Arn:build,Id:build.split(':build/')[1]}})}});
test('only native success for the exact latest build in the same execution completes a stage',async()=>{
 const requests=[];assert.equal(await stageSucceeded(async(service,command,input)=>{requests.push(input);assert.equal(service,'sfn');assert.equal(command,'GetExecutionHistory');return{events:[succeeded(arn.replace('555555555555','666666666666')),{...succeeded(arn),type:'TaskSubmitted'}]};},row),false);assert.equal(requests[0].executionArn,row.execution_arn.S);assert.equal(await stageSucceeded(async()=>({events:[succeeded(arn)]}),row),true);await assert.rejects(requireStageSucceeded(async()=>({events:[]}),row),/STILL_COMPLETING/);
});
test('history paging is followed but repeated/truncated or invalid data cannot be evidence',async()=>{
 let pages=0;assert.equal(await stageSucceeded(async(_s,_c,input)=>++pages===1?{events:[],nextToken:'next'}:(assert.equal(input.nextToken,'next'),{events:[succeeded(arn)]}),row),true);
 await assert.rejects(stageSucceeded(async()=>({events:[],nextToken:'repeated'}),row),/INCOMPLETE/);
 const event=succeeded(arn);event.taskSucceededEventDetails.outputDetails={truncated:true};await assert.rejects(stageSucceeded(async()=>({events:[event]}),row),/INCOMPLETE/);event.taskSucceededEventDetails.outputDetails={};event.taskSucceededEventDetails.output='invalid';await assert.rejects(stageSucceeded(async()=>({events:[event]}),row),/INVALID/);
});
test('an initial hold needs no build proof, while missing/cross-account evidence fails before history access',async()=>{
 let calls=0;const aws=async()=>{calls++;};assert.equal(await stageSucceeded(aws,{execution_arn:row.execution_arn}),true);for(const value of [{execution_arn:row.execution_arn,consumer_prepare_build_arn:{S:arn}},{...row,cutover_last_build_arn:{S:''}},{...row,cutover_last_build_arn:{N:'1'}},{...row,cutover_last_build_arn:{S:arn.replace('257240362763','111111111111')}},{...row,execution_arn:{S:row.execution_arn.S.replace('257240362763','111111111111')}}])await assert.rejects(stageSucceeded(aws,value));assert.equal(calls,0);
});
