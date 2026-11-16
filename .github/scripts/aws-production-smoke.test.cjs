const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runProductionSmoke}=require('./aws-production-smoke.cjs');
const context={MAINTENANCE_KIND:'smoke',MAINTENANCE_STAGE:'smoke',MAINTENANCE_TABLE:'videoq-db-maintenance-prod',MAINTENANCE_RUN_ID:'a'.repeat(32),CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-smoke-prod:00000000-0000-4000-8000-000000000001',VIDEOQ_D1_PRODUCTION_SMOKE:'true',PATH:'/synthetic/bin',HOME:'/synthetic/home',AWS_SECRET_ACCESS_KEY:'must-not-forward',DATABASE_URL:'must-not-forward',NODE_OPTIONS:'must-not-forward',OPENROUTER_API_KEY:'must-not-forward',PGOPTIONS:'must-not-forward',VERIFY_AI_ANSWERS:'true'};
const cf={CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'synthetic-only-token-'.repeat(2)};
const settings={bindings:[{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'DB',type:'d1',id:'373d6ca5-2796-460d-8ab1-e644de46bb3c'}]};
test('D1 child gets only fixed D1 and identity credentials, never PG/AWS/application secrets',async()=>{
 const parameters=[],calls=[];const result=await runProductionSmoke({env:context,root:'/synthetic/source',readParameter:name=>{parameters.push(name);return name.endsWith('/d1-migration')?cf:{key:'a'.repeat(64)};},fetcher:async()=>Response.json({success:true,result:settings}),execute:(...args)=>calls.push(args)});
 assert.deepEqual(result,{backend:'d1'});assert.deepEqual(parameters,['/videoq/security/prod/d1-migration','/videoq/security/prod/smoke-identity']);
 const [command,args,options]=calls[0];assert.equal(command,process.execPath);assert.deepEqual(args,['/synthetic/source/.github/scripts/production-smoke.mjs']);
 assert.deepEqual(Object.keys(options.env).sort(),['PATH','HOME','VIDEOQ_SMOKE_BACKEND','VIDEOQ_SMOKE_D1_DATABASE_ID','VIDEOQ_SMOKE_IDENTITY_KEY','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','VIDEOQ_BUNDLED_CHROMIUM','VERIFY_AI_ANSWERS'].sort());assert.equal(JSON.stringify(options).includes('must-not-forward'),false);assert.equal(options.env.VERIFY_AI_ANSWERS,'true');
});
test('opted-in PostgreSQL uses its existing restricted credential wrapper',async()=>{
 const parameters=[],calls=[];const result=await runProductionSmoke({env:context,root:'/synthetic/source',readParameter:name=>{parameters.push(name);return cf;},fetcher:async()=>Response.json({success:true,result:{bindings:[]}}),execute:(...args)=>calls.push(args)});
 assert.deepEqual(result,{backend:'postgres'});assert.deepEqual(parameters,['/videoq/security/prod/d1-migration']);assert.equal(calls[0][0],'python3');assert.equal(calls[0][1][1],'smoke');assert.equal(calls[0][2].env.VIDEOQ_SMOKE_BACKEND,'postgres');
});
test('disabled mode reads no Cloudflare/identity secrets and preserves PostgreSQL',async()=>{
 let calls=0;await runProductionSmoke({env:{...context,VIDEOQ_D1_PRODUCTION_SMOKE:'false'},readParameter:()=>{throw Error('unexpected parameter');},fetcher:()=>{throw Error('unexpected HTTP');},execute:()=>{calls++;}});assert.equal(calls,1);
});
test('failed detection never falls back to PostgreSQL or starts a child',async()=>{
 for(const response of [Response.json({success:false},{status:403}),Response.json({success:true,result:{bindings:[{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'}]}})]){
  let children=0;await assert.rejects(()=>runProductionSmoke({env:context,readParameter:()=>cf,fetcher:async()=>response,execute:()=>{children++;}}));assert.equal(children,0);
 }
});
test('wrong build, stage and GitHub environments fail before credentials',async()=>{
 for(const change of [{CODEBUILD_BUILD_ARN:context.CODEBUILD_BUILD_ARN.replace('smoke-prod','rotation-prod')},{MAINTENANCE_STAGE:'migration'},{GITHUB_ACTIONS:'true'},{MAINTENANCE_KIND:'backup'}])await assert.rejects(()=>runProductionSmoke({env:{...context,...change},readParameter:()=>{throw Error('credentials were accessed');}}),/AWS_SMOKE_CONTEXT_REQUIRED/);
});
