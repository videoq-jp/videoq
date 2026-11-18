const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {parse,main}=require('./run-d1-resource-operation.cjs');
const source='a'.repeat(40),run='b'.repeat(32);
const args=(directory,action='advance')=>['--action',action,'--run',run,'--source',source,'--directory',directory];
test('operator accepts one fixed action and absolute private directory, never token, force or retry arguments',()=>{
 for(const action of ['initialize','claim','advance','complete','abort'])assert.equal(parse(args('/private/run',action)).action,action);
 for(const value of [[],args('relative'),args('/private/run','release'),[...args('/private/run'),'--token','secret'],[...args('/private/run'),'--force','true']])assert.throws(()=>parse(value),/ARGUMENTS_REQUIRED/);
});
test('operator defaults disabled and rejects CI before running any command',async()=>{
 const execute=()=>assert.fail('command must not run');
 await assert.rejects(main({args:args('/private/run'),env:{},execute}),/OPERATOR_DISABLED/);
 await assert.rejects(main({args:args('/private/run'),env:{VIDEOQ_D1_RESOURCE_OPERATOR:'true',GITHUB_ACTIONS:'true'},execute}),/LOCAL_CONTEXT_REQUIRED/);
});
test('dirty source refuses credential retrieval and remote mutation before touching context',async()=>{
 let calls=0;await assert.rejects(main({args:args('/nonexistent/private/run'),env:{VIDEOQ_D1_RESOURCE_OPERATOR:'true'},execute:(program,argv)=>{
  calls++;assert.equal(program,'git');if(argv[0]==='status')return' M tracked.cjs\n';return source+'\n';
 },fetcher:()=>assert.fail('network must not run')}),/CLEAN_CANONICAL_SOURCE_REQUIRED/);assert.equal(calls,2);
});
test('resume missing context stops before authentication and cannot regenerate executor capability',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'videoq-operator-missing-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const root=path.resolve(__dirname,'../..');
 const execute=(program,argv)=>{
  if(program==='git'){
   if(argv[0]==='status')return'';
   if(argv[0]==='remote')return'https://github.com/videoq-jp/videoq.git';
   if(argv.includes('--show-toplevel'))return root;
   return source;
  }
  assert.equal(program,'gh');
  if(argv[3]==='repos/videoq-jp/videoq')return JSON.stringify({id:1083911938,owner:{id:349188820},full_name:'videoq-jp/videoq',default_branch:'main',private:false});
  assert.equal(argv[3],'repos/videoq-jp/videoq/git/ref/heads/main');return JSON.stringify({object:{sha:source}});
 };
 await assert.rejects(main({args:args(directory),env:{VIDEOQ_D1_RESOURCE_OPERATOR:'true'},execute,fetcher:()=>assert.fail('network must not run')}),/CONTEXT_FILE_REQUIRED/);
 assert.deepEqual(await fs.readdir(directory),[]);
});
test('operator composition wires private pins and scoped transports to wrapper; returns only public progress',async()=>{
 const vm=require('node:vm'),{createRequire}=require('node:module'),nativeRequire=createRequire(__filename);
 const {resourceDigest}=nativeRequire('./d1-resource-journal.cjs');
 const spec=nativeRequire('../../infra/db-maintenance/state-machine.cjs').definition({neonRetired:true,table:'videoq-db-maintenance-prod',projects:Object.fromEntries(['rotation','migration','backup','smoke','audit','deploy'].map(k=>[k,'videoq-db-'+k+'-prod']))});
 assert.deepEqual(spec.States.Operation.Choices.map(row=>row.StringEquals).sort(),['d1-resource-hold','deploy','migration','smoke']);
 const context={run,source,executorToken:'c'.repeat(64),definitionSha256:resourceDigest(spec),projectSha256:'d'.repeat(64),platformSha256:'e'.repeat(64)};
 let metadata=0,called=0,drift=false;
 const modules={
  './run-cutover-admission.cjs':{verifyReviewedSource:async()=>{},createGithubTransport:()=>async()=>{}},
  './run-d1-resource-preflight.cjs':{cloudflareToken:()=> 'PRIVATE_TOKEN_DO_NOT_PRINT'},
  './d1-resource-preflight.cjs':{createResourcePreflightAws:()=>async()=>{},createResourceMetadataTransport:()=>async()=>{},readResourcePlatform:async()=>{metadata++;return{reviewedSource:source,projectSha256:context.projectSha256,platformSha256:drift?'f'.repeat(64):context.platformSha256};},createResourcePreflight:()=>async()=>({platformSha256:context.platformSha256})},
  './cutover-api-traffic.cjs':{createCloudflareTrafficTransport:()=>async()=>{}},
  './d1-resource-aws.cjs':{createResourceAwsTransport:()=>async()=>{}},
  './d1-resource-context.cjs':{createResourceContextStore:async()=>({loadRequired:async()=>context})},
  './d1-resource-plans.cjs':{createPrivateResourcePlans:async()=>({load:async()=>null,save:async()=>{}})},
  './d1-resource-operation.cjs':{withLockedResourceRuntime:async(options,work)=>{
   called++;assert.equal(options.executorToken,context.executorToken);assert.equal(options.definitionSha256,context.definitionSha256);
   assert.equal(options.enabled,true);await options.assertRuntime({mode:'normal',step:'copy-database',stage:'before-plan'});
   return work({advance:async()=>({status:'pending',step:'copy-database',token:'PRIVATE_TOKEN_DO_NOT_PRINT',privatePlan:'DO_NOT_PRINT'})});
  }},
 };
 const module={exports:{}};vm.runInNewContext(await fs.readFile(path.join(__dirname,'run-d1-resource-operation.cjs'),'utf8'),{module,exports:module.exports,__dirname,process,fetch,console,require:Object.assign(name=>modules[name]??nativeRequire(name),{main:null})});
 const result=await module.exports.main({args:args('/private/run'),env:{VIDEOQ_D1_RESOURCE_OPERATOR:'true'}});
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{action:'advance',run,source,invocationFinished:true,status:'pending',step:'copy-database'});assert.equal(called,1);assert.equal(metadata,1);
 drift=true;await assert.rejects(module.exports.main({args:args('/private/run'),env:{VIDEOQ_D1_RESOURCE_OPERATOR:'true'}}),/CONTEXT_DRIFT/);assert.equal(called,1);
});
