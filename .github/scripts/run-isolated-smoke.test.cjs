const {test}=require('node:test'),assert=require('node:assert/strict');
const {parse,main}=require('./run-isolated-smoke.cjs');
const source='a'.repeat(40),args=['--source',source,'--manifest','/private/context/manifest.json','--pins','/private/context/pins.json'];
test('isolated CLI accepts only reviewed source and two absolute private-file paths',()=>{
 assert.deepEqual(parse(args),{source,manifestFile:'/private/context/manifest.json',pinsFile:'/private/context/pins.json'});
 for(const value of [[],[...args,'--token','forbidden'],['--source',source,'--manifest','relative','--pins','/private/pins'],['--source',source,'--source',source,'--pins','/private/pins']])assert.throws(()=>parse(value),/ARGUMENTS_REQUIRED/);
});
test('isolated CLI is disabled by default and rejects CI or PostgreSQL credentials before commands',async()=>{
 const execute=()=>assert.fail('command ran');await assert.rejects(main({args,env:{},execute}),/DISABLED/);
 for(const patch of [{GITHUB_ACTIONS:'true'},{DATABASE_URL:'not-allowed'},{VIDEOQ_FENCE_ADMIN_DATABASE_URL:'not-allowed'}])await assert.rejects(main({args,env:{VIDEOQ_ISOLATED_SMOKE_ENABLED:'true',...patch},execute}),/LOCAL_CONTEXT_REQUIRED/);
});
test('dirty source stops before manifest, credential lookup, dependencies or provider access',async()=>{
 let calls=0;await assert.rejects(main({args,env:{VIDEOQ_ISOLATED_SMOKE_ENABLED:'true'},execute:(program,argv)=>{calls++;assert.equal(program,'git');return argv[0]==='status'?' M tracked.cjs\n':source;}}),/CLEAN_CANONICAL_SOURCE_REQUIRED/);assert.equal(calls,2);
});
test('CLI wiring loads private pins before authentication and passes only constructed runtime inputs',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),nativeRequire=createRequire(__filename),events=[];
 const manifest={databaseId:'11111111-2222-4333-8444-555555555555'},pins={versions:{media:'1',search:'1',account:'1'},imageDigest:'b'.repeat(64),secretSha256:{}},report={status:'fixture'},identityKey='c'.repeat(64),token='PRIVATE_TOKEN_DO_NOT_PRINT';let mismatch=false;
 const mocks={
  './run-cutover-admission.cjs':{verifyReviewedSource:async()=>{events.push('source');}},
  './isolated-smoke-manifest.cjs':{loadIsolatedSmokeManifest:()=>{events.push('manifest');return manifest;},loadIsolatedSmokePins:(_file,context)=>{events.push('pins');assert.equal(context.manifest,manifest);assert.equal(context.identityKey,identityKey);assert.equal(context.source,source);if(mismatch)throw Error('PINS_MISMATCH');return pins;}},
  './isolated-smoke-tools.cjs':{loadIsolatedSmokeTools:async()=>{events.push('tools');return{hashPassword:async()=>{},createParser:()=>{}};}},
  './isolated-smoke-fixture.cjs':{loadReviewedSmokeFixture:input=>{events.push('fixture');assert.equal(input.source,source);return Buffer.alloc(1);}},
  './run-d1-resource-preflight.cjs':{cloudflareToken:()=>{events.push('auth');return token;}},
  './isolated-smoke-composition.cjs':{runIsolatedSmoke:async input=>{events.push('runner');assert.equal(input.source,source);assert.equal(input.manifest,manifest);assert.equal(input.env.CLOUDFLARE_ACCOUNT_ID,'12daec56fdba43f677f2766ee26a5a39');assert.equal(input.env.VIDEOQ_SMOKE_D1_DATABASE_ID,manifest.databaseId);assert.equal(input.env.CLOUDFLARE_API_TOKEN,token);assert.equal(input.env.VIDEOQ_SMOKE_IDENTITY_KEY,identityKey);assert.equal(input.versions,pins.versions);assert.equal(typeof input.hashPassword,'function');return report;}},
 };
 const module={exports:{}};vm.runInNewContext(fs.readFileSync('.github/scripts/run-isolated-smoke.cjs','utf8'),{module,exports:module.exports,__dirname,process,console,require:Object.assign(name=>mocks[name]??nativeRequire(name),{main:null})});
 assert.equal(await module.exports.main({args,env:{VIDEOQ_ISOLATED_SMOKE_ENABLED:'true',VIDEOQ_SMOKE_IDENTITY_KEY:identityKey}}),report);assert.deepEqual(events,['source','manifest','pins','tools','fixture','auth','runner']);events.length=0;mismatch=true;
 await assert.rejects(module.exports.main({args,env:{VIDEOQ_ISOLATED_SMOKE_ENABLED:'true',VIDEOQ_SMOKE_IDENTITY_KEY:identityKey}}),/PINS_MISMATCH/);assert.deepEqual(events,['source','manifest','pins']);
});
