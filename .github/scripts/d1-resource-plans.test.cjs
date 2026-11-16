const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createPrivateResourcePlans}=require('./d1-resource-plans.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'videoq-resource-plan-test-'));await fs.chmod(root,0o700);t.after(()=>fs.rm(root,{recursive:true,force:true}));return{root,plans:await createPrivateResourcePlans(root)};}
test('plans persist privately across reopening and refuse overwrite',async t=>{
 const {root,plans}=await fixture(t),value={originalTraffic:'running',version:'synthetic'};assert.equal(await plans.load('pause-api'),null);await plans.save('pause-api',value);
 assert.equal((await fs.stat(path.join(root,'pause-api.plan.json'))).mode&0o777,0o600);
 assert.deepEqual(await(await createPrivateResourcePlans(root)).load('pause-api'),value);
 await assert.rejects(plans.save('pause-api',{changed:true}),/ALREADY_EXISTS/);
});
test('relative paths, symlink roots and nonprivate directories are refused',async t=>{
 const {root}=await fixture(t);await assert.rejects(createPrivateResourcePlans('relative'),/DIRECTORY_REQUIRED/);
 const alias=root+'-link';await fs.symlink(root,alias);t.after(()=>fs.unlink(alias));await assert.rejects(createPrivateResourcePlans(alias),/DIRECTORY_REQUIRED/);
 await fs.chmod(root,0o755);await assert.rejects(createPrivateResourcePlans(root),/DIRECTORY_REQUIRED/);
});
test('symlink plans and public files cannot be read or overwritten',async t=>{
 const {root,plans}=await fixture(t),file=path.join(root,'pause-api.plan.json'),target=path.join(root,'synthetic.json');await fs.writeFile(target,'{"private":"synthetic"}',{mode:0o600});await fs.symlink(target,file);
 await assert.rejects(plans.load('pause-api'),/UNAVAILABLE/);await assert.rejects(plans.save('pause-api',{value:1}),/ALREADY_EXISTS/);
 await fs.unlink(file);await fs.writeFile(file,'{}',{mode:0o644});await assert.rejects(plans.load('pause-api'),/UNSAFE/);
});
test('invalid steps, malformed data and oversized plans fail without disclosure',async t=>{
 const {root,plans}=await fixture(t);await assert.rejects(plans.load('../escape'),/INVALID_RESOURCE_PLAN_STEP/);
 await fs.writeFile(path.join(root,'pause-api.plan.json'),'SYNTHETIC_PRIVATE_PAYLOAD',{mode:0o600});await assert.rejects(plans.load('pause-api'),{message:'PRIVATE_RESOURCE_PLAN_INVALID'});
 await assert.rejects(plans.save('pause-consumers',{value:'x'.repeat(1024*1024)}),/TOO_LARGE/);
});
test('directory replacement or permission changes invalidate an existing plan store',async t=>{
 const {root,plans}=await fixture(t);await fs.chmod(root,0o755);await assert.rejects(plans.load('pause-api'),/DIRECTORY_CHANGED/);
});
