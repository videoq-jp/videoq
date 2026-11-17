const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceBridge}=require('./d1-resource-bridge.cjs');
function options(){return{assertExecutor:async()=>{},assertOperation:async()=>{},assertTargetSafe:async()=>{},enabled:true};}
test('real Python private-pipe handshake checks ownership before, during and after child execution',async()=>{
 let executor=0,operation=0;const bridge=createResourceBridge({...options(),assertExecutor:async()=>{executor++;},assertOperation:async action=>{assert.equal(action,'ownership-check');operation++;}});
 assert.deepEqual(await bridge.call('ownership-check',{}),{owned:true});assert.equal(executor,4);assert.equal(operation,4);
});
test('default disabled bridge and unsupported operations never start a child',async()=>{
 await assert.rejects(createResourceBridge({...options(),enabled:false}).call('ownership-check',{}),/DISABLED/);
 await assert.rejects(createResourceBridge(options()).call('arbitrary-sql',{}),/ACTION_REQUIRED/);
});
test('ownership withdrawal during child handshake prevents successful result',async()=>{
 let checks=0;const bridge=createResourceBridge({...options(),assertExecutor:async()=>{if(++checks>1)throw Error('PRIVATE_OWNER_BODY');}});
 await assert.rejects(bridge.call('ownership-check',{}),{message:'RESOURCE_BRIDGE_FAILED'});
});
test('child errors and credentials remain outside public errors',async()=>{
 const bridge=createResourceBridge(options());await assert.rejects(bridge.call('prepare-fence',{run:'a'.repeat(32)},'PRIVATE_SHORT_TOKEN'),{message:'RESOURCE_BRIDGE_FAILED'});
});
test('real mutating child excludes a recovery idle probe until its guarded operation stops',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');const directory=await fs.mkdtemp(path.join(os.tmpdir(),'videoq-worker-barrier-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let entered,release,checks=0;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const active=createResourceBridge({...options(),directory,assertOperation:async()=>{checks++;if(checks===2){entered();await gate;throw Error('RESOURCE_SYNTHETIC_STOP_BEFORE_PROVIDER');}}});
 const operation=active.call('install-source-fence',{plan:{}},'SYNTHETIC_TOKEN');const failed=assert.rejects(operation,/RESOURCE_BRIDGE_FAILED/);await ready;
 const probe=createResourceBridge({...options(),directory});await assert.rejects(probe.call('worker-lock-check',{}),/RESOURCE_BRIDGE_FAILED/);release();await failed;assert.deepEqual(await probe.call('worker-lock-check',{}),{owned:true,exclusiveWorker:true});
});
test('mutating child without a private worker directory cannot enter provider code',async()=>{
 const bridge=createResourceBridge(options());await assert.rejects(bridge.call('install-source-fence',{plan:{}},'SYNTHETIC_TOKEN'),/RESOURCE_BRIDGE_FAILED/);
});
