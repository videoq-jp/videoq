const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {readResourcePlatform,createResourcePreflight,createResourcePreflightAws,createResourceMetadataTransport}=require('./d1-resource-preflight.cjs');
const source='a'.repeat(40),root=path.resolve(__dirname,'../..');
function fixture(){
 const flags={MAINTENANCE_TABLE:'videoq-db-maintenance-prod',VIDEOQ_CUTOVER_CONSUMER_CONTROL:'false',VIDEOQ_CUTOVER_FINAL_HANDOFF:'false',VIDEOQ_CUTOVER_POSTWRITE_RECOVERY:'false',VIDEOQ_D1_PRODUCTION_SMOKE:'true',VIDEOQ_RETAIN_BACKUP:'false',VIDEOQ_EXPORT_D1_FROM_BACKUP:'false'},calls=[];
 const project={name:'videoq-db-smoke-prod',arn:'arn:aws:codebuild:ap-northeast-1:257240362763:project/videoq-db-smoke-prod',serviceRole:'arn:aws:iam::257240362763:role/videoq-db-smoke-prod',source:{type:'S3',location:'videoq-db-maintenance-prod-257240362763/operator.zip',buildspec:'reviewed-buildspec'},sourceVersion:'immutable-version',concurrentBuildLimit:1,tags:[{key:'ReviewedSource',value:source}],environment:{type:'LINUX_CONTAINER',image:'aws/codebuild/standard:7.0',computeType:'BUILD_GENERAL1_SMALL',privilegedMode:false,imagePullCredentialsType:'CODEBUILD',environmentVariables:Object.entries(flags).map(([name,value])=>({name,value,type:'PLAINTEXT'}))}};
 const databases=[{uuid:'e57d0931-18cb-4f00-ae7f-b0068030fb04',name:'videoq-d1-migration-staging-v4',read_replication:{mode:'disabled'}},{uuid:'587bd210-6d9d-4f32-abb7-a490013e65d3',name:'videoq-prod-db',read_replication:{mode:'disabled'}}];
 const indexes=['videoq-scenes-migration-v3-1536','videoq-scenes-migration-v3-768','videoq-prod-scenes-1536','videoq-prod-scenes-768'].map(name=>({name,config:{dimensions:name.endsWith('1536')?1536:768,metric:'cosine'}}));
 let account='257240362763',dirty=false,head=source,diverged=false;
 const aws=async(service,command,input)=>{calls.push({service,command,input});if(service==='sts')return{Account:account};assert.equal(command,'BatchGetProjects');return{projects:[structuredClone(project)]};};
 const cloudflare=async(method,url)=>{calls.push({method,url});assert.equal(method,'GET');return structuredClone(url.includes('/d1/')?databases.find(v=>url.endsWith(v.uuid)):indexes.find(v=>url.endsWith(v.name)));};
 const execute=(program,args,options)=>{
  if(program==='git'){if(args[0]==='status')return dirty?' M tracked.cjs\n':'';if(args[0]==='remote')return'https://github.com/videoq-jp/videoq.git\n';return args[1]==='HEAD'?source+'\n':root+'\n';}
  assert.equal(program,'gh');assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);const url=args[3];
  if(url==='repos/videoq-jp/videoq')return JSON.stringify({id:1083911938,owner:{id:349188820},full_name:'videoq-jp/videoq',default_branch:'main',private:false});
  if(url.endsWith('/git/ref/heads/main'))return JSON.stringify({object:{sha:head}});return JSON.stringify({status:diverged?'diverged':'ahead',merge_base_commit:{sha:source}});
 };
 return{aws,cloudflare,execute,project,databases,indexes,calls,wrongAccount:()=>account='111111111111',dirty:()=>dirty=true,advanceMain:()=>head='b'.repeat(40),diverge:()=>{head='b'.repeat(40);diverged=true;}};
}
test('read-only platform proof validates fixed AWS identity, reviewed D1 smoke and all six Cloudflare resources',async()=>{
 const f=fixture(),value=await readResourcePlatform(f);assert.equal(value.reviewedSource,source);assert.equal(value.databases.length,2);assert.equal(value.indexes.length,4);assert.equal(value.projectSha256.length,64);assert.ok(!JSON.stringify(value).includes('environmentVariables'));assert.equal(f.calls.filter(v=>v.method==='GET').length,6);
});
test('wrong AWS account stops before Cloudflare; legacy flags, role, resource identity or search geometry refuse',async()=>{
 const f=fixture();f.wrongAccount();await assert.rejects(readResourcePlatform(f),/ACCOUNT_MISMATCH/);assert.equal(f.calls.length,1);
 for(const mutate of [f=>f.project.serviceRole='unreviewed-role',f=>f.project.environment.privilegedMode=true,f=>f.project.environment.environmentVariables.find(v=>v.name==='VIDEOQ_RETAIN_BACKUP').value='true',f=>f.databases[1].uuid='other',f=>f.databases[0].read_replication.mode='auto',f=>f.indexes[2].config.metric='euclidean',f=>f.indexes[3].config.dimensions=1536]){const f=fixture();mutate(f);await assert.rejects(readResourcePlatform(f));}
});
test('canonical clean source is required before provider reads; ancestor recovery and pinned project are enforced',async()=>{
 const f=fixture(),platform=await readResourcePlatform(f),guard=createResourcePreflight({source,expectedProjectSha256:platform.projectSha256,...f,env:{CLOUDFLARE_API_TOKEN:'synthetic-cloudflare-token-0123456789'}});
 f.advanceMain();assert.equal((await guard({mode:'abort',step:'recovery',stage:'before-progress'})).currentMain,'b'.repeat(40));
 f.project.sourceVersion='changed';await assert.rejects(guard({mode:'normal',step:'claim',stage:'before-claim'}),/PROJECT_DRIFT/);
 for(const mutate of [f=>f.dirty(),f=>f.diverge()]){const g=fixture(),p=await readResourcePlatform(g),check=createResourcePreflight({source,expectedProjectSha256:p.projectSha256,...g,env:{}});g.calls.length=0;mutate(g);await assert.rejects(check({mode:'normal',step:'claim',stage:'before-claim'}));assert.equal(g.calls.length,0);}
});
test('AWS preflight transport excludes SSM, IAM and app credentials, and removes private request files',async()=>{
 let called=0,requestFile;const aws=createResourcePreflightAws({env:{PATH:process.env.PATH,HOME:process.env.HOME,AWS_PROFILE:'operator',GH_TOKEN:'github-only',CLOUDFLARE_API_TOKEN:'cloudflare-only',NODE_OPTIONS:'forbidden'},execute:(program,args,options)=>{
  called++;assert.equal(program,'aws');assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(options.env.GH_TOKEN,undefined);assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.AWS_PROFILE,'operator');requestFile=args.at(-1).slice(7);assert.equal(fs.statSync(requestFile).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(requestFile)).mode&0o777,0o700);assert.ok(args.includes('--no-paginate'));return'{}';
 }});
 for(const args of [['ssm','GetParameter',{}],['iam','PutRolePolicy',{}],['codebuild','StartBuild',{}],['codebuild','BatchGetProjects',{names:['other']}]] )await assert.rejects(aws(...args),/OPERATION_REFUSED/);assert.equal(called,0);await aws('sts','GetCallerIdentity',{});assert.equal(fs.existsSync(requestFile),false);
});
test('Cloudflare preflight permits only fixed GET metadata and sanitizes failure bodies without retry',async()=>{
 let calls=0;const url='accounts/12daec56fdba43f677f2766ee26a5a39/d1/database/e57d0931-18cb-4f00-ae7f-b0068030fb04';
 const transport=createResourceMetadataTransport('synthetic-cloudflare-token-0123456789',{fetcher:async(request,options)=>{calls++;assert.equal(options.redirect,'error');assert.ok(request.startsWith('https://api.cloudflare.com/client/v4/'));return new Response('PRIVATE_PROVIDER_BODY',{status:403});}});
 await assert.rejects(transport('POST',url+'/query'),/OPERATION_REFUSED/);await assert.rejects(transport('GET','accounts/other/d1/database/other'),/OPERATION_REFUSED/);assert.equal(calls,0);await assert.rejects(transport('GET',url),{message:'RESOURCE_PREFLIGHT_CF_READ_FAILED'});assert.equal(calls,1);
 const success=createResourceMetadataTransport('synthetic-cloudflare-token-0123456789',{fetcher:async()=>new Response(JSON.stringify({success:true,errors:[],result:{uuid:'fixed'}}))});assert.deepEqual(await success('GET',url),{uuid:'fixed'});
});

test('a mismatched ReviewedSource tag refuses a pinned project even if its execution digest is unchanged',async()=>{
 const f=fixture(),platform=await readResourcePlatform(f),guard=createResourcePreflight({source,expectedProjectSha256:platform.projectSha256,...f,env:{}});f.project.tags[0].value='b'.repeat(40);await assert.rejects(guard({mode:'normal',step:'claim',stage:'before-claim'}),/SOURCE_OR_PROJECT_DRIFT/);
});
test('oversized or malformed Cloudflare metadata never escapes as an accepted resource proof',async()=>{
 const url='accounts/12daec56fdba43f677f2766ee26a5a39/d1/database/e57d0931-18cb-4f00-ae7f-b0068030fb04';
 for(const body of ['x'.repeat(2*1024*1024+1),JSON.stringify({success:true,errors:[],result:[]}),JSON.stringify({success:false,errors:[{message:'PRIVATE_PROVIDER_BODY'}],result:{}})]){const transport=createResourceMetadataTransport('synthetic-cloudflare-token-0123456789',{fetcher:async()=>new Response(body)});await assert.rejects(transport('GET',url),{message:'RESOURCE_PREFLIGHT_CF_READ_FAILED'});}
});
