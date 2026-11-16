const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runRecoveryChild}=require('./cutover-recovery-child.cjs');
const snapshot='a'.repeat(64),manifest='b'.repeat(64),input='c'.repeat(43)+'=';
const message={event:'recovery_prepared',snapshotSha256:snapshot,manifestSha256:manifest,inputSha256:input};
const setup=`const prepared=${JSON.stringify(message)};console.log(JSON.stringify(prepared));`;
const wait=`process.stdin.once('data',b=>{const v=JSON.parse(b);if(v.authorize!==true||v.snapshotSha256!==prepared.snapshotSha256)process.exit(7);console.log(JSON.stringify({event:'recovery_committed',snapshotSha256:v.snapshotSha256,postgresLoginFenceVerified:true}));});`;
const options=(code,onPrepared)=>({command:process.execPath,args:['-e',code],cwd:process.cwd(),env:{PATH:process.env.PATH},onPrepared,timeoutMs:1000});
test('child receives a matching grant only after asynchronous intent persistence completes',async()=>{
 let saved=false;const result=await runRecoveryChild(options(setup+wait,async value=>{assert.deepEqual(value,message);await new Promise(r=>setTimeout(r,10));saved=true;}));assert.equal(saved,true);assert.equal(result.committed.snapshotSha256,snapshot);
});
test('failed or ambiguous persistence never sends a database grant',async()=>{
 await assert.rejects(()=>runRecoveryChild(options(setup+wait,async()=>{throw Error('synthetic lost persistence');})),/KEEP_WRITERS_STOPPED/);
});
test('unexpected digest, duplicate prepared event, EOF and failed exit reject completion',async()=>{
 for(const code of [setup+`console.log(JSON.stringify(prepared));`+wait,setup+`process.exit(0);`,setup+wait.replace("snapshotSha256:v.snapshotSha256","snapshotSha256:'f'.repeat(64)"),setup+`process.exit(3);`])await assert.rejects(()=>runRecoveryChild(options(code,async()=>{})),/KEEP_WRITERS_STOPPED/);
});
test('oversized or stalled children are bounded and cannot produce a receipt',async()=>{
 for(const code of [`console.log('x'.repeat(17000));setInterval(()=>{},100);`,`setInterval(()=>{},100);`])await assert.rejects(()=>runRecoveryChild({...options(code,async()=>{}),timeoutMs:30}),/KEEP_WRITERS_STOPPED/);
});
test('a stalled persistence callback is bounded even if the child has already exited',async()=>{
 for(const code of [setup+wait,setup])await assert.rejects(()=>runRecoveryChild({...options(code,()=>new Promise(()=>{})),timeoutMs:150}),/KEEP_WRITERS_STOPPED/);
});
