const {test}=require('node:test'),assert=require('node:assert/strict');
const {withLockedResourceRuntime}=require('./d1-resource-operation.cjs');
test('locked runtime requires explicit enablement and real guard transports before acquiring a lock',async()=>{
 await assert.rejects(withLockedResourceRuntime({},()=>{}),/RUNTIME_DISABLED/);
 await assert.rejects(withLockedResourceRuntime({enabled:true},()=>{}),/RUNTIME_CONTEXT/);
 await assert.rejects(withLockedResourceRuntime({enabled:true},null),/RUNTIME_CONTEXT/);
});
test('callback failure waits for its started runtime action before releasing the real lock',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{withResourceLock}=require('./d1-resource-lock.cjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'videoq-operation-drain-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let entered,continueAction,reads=0;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>continueAction=resolve),failure=Error('synthetic callback failure');
 const options={enabled:true,directory,run:'a'.repeat(32),source:'b'.repeat(40),executorToken:'c'.repeat(64),definitionSha256:'d'.repeat(64),token:'SYNTHETIC_RESOURCE_TOKEN_0123456789',plans:{load:async()=>null,save:async()=>{}},assertRuntime:async()=>{entered();await gate;},assertRecoveryLease:async()=>{},aws:async()=>{reads++;throw Error('SYNTHETIC_READ_REFUSED');},cloudflare:async()=>assert.fail('Cloudflare called'),lambda:async()=>assert.fail('Lambda called'),github:async()=>assert.fail('GitHub called')};
 const work=withLockedResourceRuntime(options,async runtime=>{runtime.claim();throw failure;});await started;
 await assert.rejects(withResourceLock({directory},async()=>assert.fail('lock released before pending action settled')),/RESOURCE_EXECUTOR_BUSY/);
 continueAction();await assert.rejects(work,error=>error===failure);assert.ok(reads>0);await withResourceLock({directory},async()=>{});
});
