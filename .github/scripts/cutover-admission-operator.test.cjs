const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync,existsSync}=require('node:fs');
const {resolve,dirname}=require('node:path');
const {parse,executionEnv,verifyReviewedSource,createAwsTransport,createGithubTransport,main}=require('./run-cutover-admission.cjs');
const root=resolve(__dirname,'../..'),sha='a'.repeat(40),head='b'.repeat(40),run='c'.repeat(32);
function sourceFixture({dirty=false,diverged=false,wrongRepository=false}={}){
 const calls=[];
 const execute=(program,args,options)=>{calls.push({program,args,options});
  if(program==='git'){
   if(args[0]==='status')return dirty?' M tracked-code.cjs\n':'';
   if(args[0]==='remote')return'https://github.com/videoq-jp/videoq.git\n';
   return args[1]==='HEAD'?sha+'\n':root+'\n';
  }
  assert.equal(program,'gh');assert.deepEqual(args.slice(0,3),['api','--hostname','github.com']);const path=args[3];
  if(path==='repos/videoq-jp/videoq')return JSON.stringify({id:wrongRepository?42:1083911938,owner:{id:349188820},full_name:'videoq-jp/videoq',default_branch:'main',private:false});
  if(path.endsWith('/git/ref/heads/main'))return JSON.stringify({object:{sha:head}});
  assert.equal(path,`repos/videoq-jp/videoq/compare/${sha}...${head}?per_page=1`);return JSON.stringify({status:diverged?'diverged':'ahead',merge_base_commit:{sha:diverged?head:sha}});
 };
 return{execute,calls};
}
test('only the fixed admission actions and exact run/source shape parse',()=>{
 assert.deepEqual(parse(['--action','pause-api','--run',run,'--source',sha]),{action:'pause-api',run,source:sha});
 for(const args of [[],['--action','sql','--run',run,'--source',sha],['--action','pause-api','--run','other','--source',sha],['--action','pause-api','--action','pause-api','--source',sha],['--action','pause-api','--run',run,'--source',sha,'--project','arbitrary']])assert.throws(()=>parse(args));
});
test('a clean source must be in canonical main history, so a pinned hold can recover after main advances',async()=>{
 const f=sourceFixture();assert.deepEqual(await verifyReviewedSource({source:sha,root,execute:f.execute,env:{PATH:'fixture'}}),{reviewedSource:sha,currentMain:head});
 for(const options of [{dirty:true},{diverged:true},{wrongRepository:true}]){const f=sourceFixture(options);await assert.rejects(verifyReviewedSource({source:sha,root,execute:f.execute,env:{}}));if(options.dirty)assert.equal(f.calls.some(c=>c.program==='gh'),false);}
});
test('CLI source/account checks precede any cloud or workflow mutation',async()=>{
 const f=sourceFixture(),execute=(program,args,options)=>program==='aws'?JSON.stringify({Account:'111111111111'}):f.execute(program,args,options);let requests=0;
 await assert.rejects(main({args:['--action','pause-api','--run',run,'--source',sha],root,execute,env:{CLOUDFLARE_API_TOKEN:'synthetic-only-token-0123456789'},fetcher:async()=>{requests++;}}),/ACCOUNT_MISMATCH/);assert.equal(requests,0);
 await assert.rejects(main({args:['--action','pause-api','--run',run,'--source',sha],root,execute:()=>{throw Error('must not execute');},env:{GITHUB_ACTIONS:'true'}}),/LOCAL_METADATA_OPERATOR/);
});
test('metadata transport denies SSM IAM SQL and consumer mutation and removes unrelated credentials',async()=>{
 let directory,calls=0;const env={PATH:'fixture',HOME:'fixture-home',AWS_PROFILE:'operator',AWS_ACCESS_KEY_ID:'aws-only',GH_TOKEN:'github-only',CLOUDFLARE_API_TOKEN:'cloudflare-only',VIDEOQ_FENCE_ADMIN_DATABASE_URL:'forbidden',NODE_OPTIONS:'forbidden',PGPASSWORD:'forbidden'};
 const aws=createAwsTransport({env,root,execute:(program,args,options)=>{calls++;assert.equal(program,'aws');assert.equal(options.env.GH_TOKEN,undefined);assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.VIDEOQ_FENCE_ADMIN_DATABASE_URL,undefined);assert.equal(options.env.AWS_PROFILE,'operator');const file=args.at(-1).slice('file://'.length);directory=dirname(file);assert.deepEqual(JSON.parse(readFileSync(file)),{TableName:'fixed-table'});return'{}';}});
 for(const pair of [['ssm','GetParameter'],['iam','PutRolePolicy'],['lambda','UpdateEventSourceMapping'],['rds','ExecuteStatement']])await assert.rejects(aws(...pair,{}));assert.equal(calls,0);await aws('ddb','GetItem',{TableName:'fixed-table'});assert.equal(calls,1);assert.equal(existsSync(directory),false);
 const gh=executionEnv(env,'github');assert.equal(gh.GH_TOKEN,'github-only');assert.equal(gh.AWS_ACCESS_KEY_ID,undefined);assert.equal(gh.CLOUDFLARE_API_TOKEN,undefined);
});
test('GitHub transport can change only admission on the two existing deployment workflows',async()=>{
 let calls=0;const gh=createGithubTransport({env:{},root,execute:(_p,args)=>{calls++;assert.ok(args.includes('--hostname'));return'';}});
 await gh('PUT','repos/videoq-jp/videoq/actions/workflows/252628432/disable');assert.equal(calls,1);
 for(const [method,path]of[['DELETE','repos/videoq-jp/videoq/actions/workflows/252628432'],['PUT','repos/videoq-jp/videoq/actions/workflows/1/disable'],['PUT','repos/videoq-jp/videoq/actions/workflows/252628432/dispatches'],['GET','repos/other/repository/actions/workflows/252628432']])await assert.rejects(gh(method,path));assert.equal(calls,1);
});
