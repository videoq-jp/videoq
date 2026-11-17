const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {withResourceLock}=require('./d1-resource-lock.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'videoq-coordinator-lock-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('real keeper excludes overlapping coordinators and serializes checks across awaited work',async t=>{
 const directory=await fixture(t);let retained;
 assert.equal(await withResourceLock({directory},async({assertLocked})=>{
  retained=assertLocked;await Promise.all([assertLocked(),assertLocked(),assertLocked()]);
  await assert.rejects(withResourceLock({directory},async()=>assert.fail('competing callback ran')),/RESOURCE_EXECUTOR_BUSY/);
  await assertLocked();return 'done';
 }),'done');await assert.rejects(retained(),/KEEPER_LOST/);
 const inode=(await fs.stat(path.join(directory,'coordinator.lock'))).ino;
 await withResourceLock({directory},async({assertLocked})=>assertLocked());assert.equal((await fs.stat(path.join(directory,'coordinator.lock'))).ino,inode);
});
test('callback failure releases local ownership without deleting the lock inode',async t=>{
 const directory=await fixture(t),failure=Error('synthetic task failure');
 await assert.rejects(withResourceLock({directory},async()=>{throw failure;}),error=>error===failure);
 await withResourceLock({directory},async({assertLocked})=>assertLocked());assert.equal((await fs.stat(path.join(directory,'coordinator.lock'))).mode&0o777,0o600);
});
test('lock inode replacement stops active work and refuses replacement acquisition',async t=>{
 const directory=await fixture(t);
 await assert.rejects(withResourceLock({directory},async({assertLocked})=>{
  await fs.rename(path.join(directory,'coordinator.lock'),path.join(directory,'retained-old.lock'));
  await fs.writeFile(path.join(directory,'coordinator.lock'),'',{mode:0o600});await assertLocked();
 }),/RESOURCE_EXECUTOR_LOCK_REPLACED/);
 await assert.rejects(withResourceLock({directory},async()=>assert.fail('replacement callback ran')),/COORDINATOR_IDENTITY_CHANGED/);
});
test('symlink directory and invalid callback refuse work',async t=>{
 const directory=await fixture(t),link=directory+'-link';t.after(()=>fs.unlink(link));await fs.symlink(directory,link);
 await assert.rejects(withResourceLock({directory:link},async()=>assert.fail('symlink callback ran')),/PRIVATE_DIRECTORY_REQUIRED/);
 await assert.rejects(withResourceLock({directory},null),/CALLBACK_REQUIRED/);
});
test('abnormal keeper EOF cannot be replaced while its parent remains alive',async t=>{
 const directory=await fixture(t),child=spawn('python3',[path.resolve(__dirname,'../../infra/scripts/d1_resource_coordinator_lock.py')],{stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'}});
 const closed=once(child,'close');t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const ready=once(child.stdout,'data');child.stdin.write(JSON.stringify({version:1,directory,parentPid:process.pid,owner:'f'.repeat(64)})+'\n');assert.equal(JSON.parse(String((await ready)[0])).event,'ready');child.stdin.end();await closed;
 await assert.rejects(withResourceLock({directory},async()=>assert.fail('abnormal takeover callback ran')),/PARENT_STILL_RUNNING/);
});

test('falsy callback failures are preserved after releasing the lock',async t=>{
 const directory=await fixture(t);let caught=false;try{await withResourceLock({directory},async()=>{throw null;});}catch(error){caught=true;assert.equal(error,null);}assert.equal(caught,true);await withResourceLock({directory},async()=>{});
});
