const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
test('composition verifies source first and uses its concrete guard/store factories instead of caller overrides',async()=>{
 const events=[],aws=async()=>{},assertAws=async()=>{},assertImage=async()=>{},store={},report={status:'fixture'},requireNative=createRequire(__filename);let dirty=false;
 const deps={
  './run-cutover-admission.cjs':{verifyReviewedSource:async()=>{events.push('source');if(dirty)throw Error('CLEAN_CANONICAL_SOURCE_REQUIRED');}},
  './isolated-smoke-aws-transport.cjs':{createIsolatedAwsTransport:()=>{events.push('aws');return aws;}},
  './isolated-smoke-aws.cjs':{createIsolatedAwsGuard:input=>{assert.equal(input.aws,aws);return assertAws;}},
  './isolated-smoke-image.cjs':{createDeployedWorkerImageCheck:()=>assertImage},
  './production-smoke-store.cjs':{isolatedD1SmokeStore:()=>store},
  './isolated-smoke-runner.cjs':{runIsolatedVideoSmoke:async input=>{assert.equal(input.store,store);assert.equal(input.assertAws,assertAws);assert.equal(input.assertImage,assertImage);events.push('runner');return report;}},
 };
 const module={exports:{}};vm.runInNewContext(fs.readFileSync('.github/scripts/isolated-smoke-composition.cjs','utf8'),{module,exports:module.exports,__dirname,process,fetch,require:name=>deps[name]??requireNative(name)});
 const run=module.exports.runIsolatedSmoke,options={source:'a'.repeat(40),env:{},assertAws:()=>assert.fail('external guard used'),assertImage:()=>assert.fail('external guard used')};
 assert.equal(await run(options),report);assert.deepEqual(events,['source','aws','runner']);events.length=0;dirty=true;await assert.rejects(run(options),/CLEAN_CANONICAL_SOURCE_REQUIRED/);assert.deepEqual(events,['source']);events.length=0;
 await assert.rejects(run({...options,env:{GITHUB_ACTIONS:'true'}}),/LOCAL_CONTEXT_REQUIRED/);assert.deepEqual(events,[]);
});
