const {test}=require('node:test'),assert=require('node:assert/strict');
const {createOwnedApiTraffic,verifyProductionTraffic}=require('./cutover-owned-api-traffic.cjs');
test('owned API capability and callback context fail before any transport',async()=>{
 let calls=0;const config={aws:()=>{calls++;},request:()=>{calls++;},table:'unused',machine:'unused',expectedDefinitionHash:'a'.repeat(64)},command={action:'pause',run:'b'.repeat(32),source:'c'.repeat(40)};
 await assert.rejects(createOwnedApiTraffic(config)(command),/DISABLED/);await assert.rejects(createOwnedApiTraffic({...config,enabled:true})(command),/CONTEXT/);assert.equal(calls,0);
});
const paused=()=>Response.json({error:{code:'MIGRATION_PAUSED'}},{status:503,headers:{'retry-after':'60','cache-control':'no-store'}});
test('public pause verification checks liveness, readiness and pre-auth rejection without any credential',async()=>{
 const paths=[];const result=await verifyProductionTraffic(true,async(url,options)=>{assert.equal(options.headers,undefined);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');paths.push(url);return url.endsWith('/health')?Response.json({data:{status:'ok'}}):paused();});assert.equal(result.applicationPauseVerified,true);assert.equal(result.inFlightDrainProven,false);assert.deepEqual(paths,['https://videoq.jp/health','https://videoq.jp/ready','https://videoq.jp/api/auth/get-session']);
});
test('HTTP 503 alone, wrong error body or missing no-store cannot prove application pause',async()=>{
 for(const bad of [()=>Response.json({error:{code:'OTHER'}},{status:503}),()=>Response.json({error:{code:'MIGRATION_PAUSED'}},{status:200}),()=>Response.json({error:{code:'MIGRATION_PAUSED'}},{status:503,headers:{'retry-after':'60'}})])await assert.rejects(verifyProductionTraffic(true,async url=>url.endsWith('/health')?Response.json({}):bad()),/PAUSE_NOT_VERIFIED/);
});
test('restore requires actual database readiness and rejects unready or oversized public responses',async()=>{
 const result=await verifyProductionTraffic(false,async url=>Response.json(url.endsWith('/health')?{}:{data:{status:'ready',db:'ok'}}));assert.equal(result.applicationReadyVerified,true);
 for(const body of [{data:{status:'unready',db:'ok'}},{data:{status:'ready',db:'down'}}])await assert.rejects(verifyProductionTraffic(false,async url=>Response.json(url.endsWith('/health')?{}:body)),/READY_NOT_VERIFIED/);
 await assert.rejects(verifyProductionTraffic(false,async()=>new Response('x'.repeat(8193))),/PROBE_FAILED/);
});
