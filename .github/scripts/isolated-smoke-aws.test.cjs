const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {createIsolatedAwsGuard}=require('./isolated-smoke-aws.cjs');
const {createIsolatedAwsTransport}=require('./isolated-smoke-aws-transport.cjs');
const {validateIsolatedSmokeManifest}=require('./isolated-smoke-target.cjs');
function fixture(){
 const manifest={version:1,nonce:'a'.repeat(16),databaseId:'11111111-2222-4333-8444-555555555555',workersSubdomain:'synthetic-account',issuedAt:1000,expiresAt:100000},target=validateIsolatedSmokeManifest(manifest,2000),versions={media:'1',search:'1',account:'1'},imageDigest='b'.repeat(64),prefix='videoq-isolated-'+manifest.nonce+'-',arn=name=>'arn:aws:sqs:ap-northeast-1:257240362763:'+name,url=name=>'https://sqs.ap-northeast-1.amazonaws.com/257240362763/'+name,role='arn:aws:iam::257240362763:role/videoq-worker-prod';
 const secrets=Object.fromEntries(['WORKER_INTERNAL_API_SECRET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'].map(k=>[k,'synthetic-not-real-'+k])),secretSha256=Object.fromEntries(Object.entries(secrets).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')]));
 const calls=[];let clock=2000,mutate=()=>{};
 const aws=async(service,command,input)=>{
  calls.push({service,command,input});let response;
  if(command==='GetCallerIdentity')response={Account:'257240362763'};
  else if(command==='GetQueueAttributes'){
   const name=input.QueueUrl.split('/').at(-1),dlq=name.endsWith('-dlq');const attributes={QueueArn:arn(name),VisibilityTimeout:'1800',Policy:JSON.stringify({Statement:[{Effect:'Deny',Principal:'*',Action:'sqs:*',Resource:arn(name),Condition:{Bool:{'aws:SecureTransport':'false'}}}]})};
   if(!dlq){attributes.RedrivePolicy=JSON.stringify({deadLetterTargetArn:arn(name+'-dlq'),maxReceiveCount:3});attributes.Policy=JSON.stringify({Statement:[{Effect:'Deny',Principal:'*',Action:'sqs:*',Resource:arn(name),Condition:{Bool:{'aws:SecureTransport':'false'}}},{Effect:'Allow',Principal:{AWS:role},Resource:arn(name),Action:['sqs:SendMessage','sqs:ReceiveMessage','sqs:DeleteMessage','sqs:ChangeMessageVisibility','sqs:GetQueueAttributes','sqs:GetQueueUrl']}]});}
   response={Attributes:attributes};
  }else if(command==='ListQueueTags')response={Tags:{'videoq-operation':'isolated-e2e','videoq-nonce':manifest.nonce}};
  else if(command==='GetFunction'){
   response={Code:{ResolvedImageUri:'257240362763.dkr.ecr.ap-northeast-1.amazonaws.com/videoq-worker-prod@sha256:'+imageDigest},Configuration:{FunctionName:input.FunctionName.split(':').at(-1),FunctionArn:input.FunctionName+':'+input.Qualifier,Version:input.Qualifier,Role:role,PackageType:'Image',State:'Active',Architectures:['arm64'],Timeout:300,ImageConfigResponse:{ImageConfig:{Command:['handler.handler']}},Environment:{Variables:{DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',WORKER_INTERNAL_API_ORIGIN:target.origin,FRONTEND_URL:target.origin,USE_S3_STORAGE:'true',R2_BUCKET_NAME:target.bucket,R2_S3_ENDPOINT:`https://${target.accountId}.r2.cloudflarestorage.com`,R2_S3_REGION:'auto',SQS_QUEUE_URL:url(prefix+'media'),SQS_QUEUE_NAME:prefix+'media',SQS_MEDIA_QUEUE_URL:url(prefix+'media'),SQS_SEARCH_QUEUE_URL:url(prefix+'search'),SQS_ACCOUNT_QUEUE_URL:url(prefix+'account'),EMBEDDING_PROVIDER:'workers-ai',EMBEDDING_MODEL:'@cf/google/embeddinggemma-2',EMBEDDING_PROFILE:'embeddinggemma2',WHISPER_BACKEND:'workers-ai',ENABLE_HEAVY_PIPELINE:'true',VIDEO_VISUAL_ENABLED:'true',MEDIA_PROCESS_MEMORY_LIMIT_MB:'2048',MEDIA_PROCESS_CPU_TIME_LIMIT_SECONDS:'300',FFMPEG_PROCESS_TIMEOUT_SECONDS:'600',MEDIA_PROCESS_OUTPUT_FILE_SIZE_LIMIT_MB:'1024',...secrets}}}};
  }else if(command==='ListEventSourceMappings')response={EventSourceMappings:[{FunctionArn:input.FunctionName+':1',EventSourceArn:arn(prefix+input.FunctionName.split('-').at(-1)),State:'Enabled',BatchSize:1,FunctionResponseTypes:['ReportBatchItemFailures']}]};
  else assert.fail('unexpected command');mutate(service,command,input,response);return response;
 };
 return{manifest,versions,imageDigest,secretSha256,aws,calls,now:()=>clock,setClock:v=>{clock=v;},mutate:fn=>{mutate=fn;}};
}
test('configuration proof pins numeric Lambda versions, image, queue topology, config and secret digests using reads only',async()=>{
 const f=fixture();assert.deepEqual(await createIsolatedAwsGuard(f)(),{awsConfigurationVerified:true,sharedProductionExecutionRole:true});assert.equal(f.calls.length,19);assert.ok(f.calls.every(v=>['GetCallerIdentity','GetQueueAttributes','ListQueueTags','GetFunction','ListEventSourceMappings'].includes(v.command)));
});
test('production references, image/role/secret drift, unsafe queue policy and extra mappings refuse proof',async()=>{
 const cases=[
  ['GetFunction',r=>{r.Configuration.Environment.Variables.APP_PARAM_NAME='/videoq/prod/app';}],
  ['GetFunction',r=>{r.Configuration.Environment.Variables.DB_PARAM_NAME='/videoq/prod/worker-db';}],
  ['GetFunction',r=>{r.Configuration.Environment.Variables.OPENAI_API_KEY='forbidden';}],
  ['GetFunction',r=>{r.Configuration.Environment.Variables.ENABLE_HEAVY_PIPELINE='false';}],
  ['GetFunction',r=>{r.Configuration.Environment.Variables.UNREVIEWED_OVERRIDE='forbidden';}],
  ['GetFunction',r=>{r.Configuration.Environment.Variables.WORKER_INTERNAL_API_ORIGIN='https://videoq.jp';}],
  ['GetFunction',r=>{r.Configuration.Environment.Variables.R2_BUCKET_NAME='videoq-media-prod';}],
  ['GetFunction',r=>{r.Configuration.Environment.Variables.WORKER_INTERNAL_API_SECRET='wrong';}],
  ['GetFunction',r=>{r.Code.ResolvedImageUri+='different';}],
  ['GetFunction',r=>{r.Configuration.Role='arn:aws:iam::257240362763:role/other';}],
  ['GetQueueAttributes',r=>{if(r.Attributes.Policy)r.Attributes.Policy=JSON.stringify({Statement:[{Effect:'Allow',Principal:'*',Action:['sqs:*'],Resource:'*'}]});}],
  ['GetQueueAttributes',r=>{r.Attributes.VisibilityTimeout='960';}],
  ['GetQueueAttributes',r=>{if(r.Attributes.RedrivePolicy)r.Attributes.RedrivePolicy=JSON.stringify({deadLetterTargetArn:'production',maxReceiveCount:3});}],
  ['ListEventSourceMappings',r=>{r.EventSourceMappings.push(r.EventSourceMappings[0]);}],
  ['ListEventSourceMappings',r=>{r.EventSourceMappings[0].State='Disabled';}],
  ['ListQueueTags',r=>{r.Tags['videoq-nonce']='other';}],
 ];
 for(const [command,mutate] of cases){const f=fixture();f.mutate((_s,c,_i,r)=>{if(c===command)mutate(r);});await assert.rejects(createIsolatedAwsGuard(f)(),/CONFIGURATION_DRIFT/);}
});
test('bad context, expiry and provider exceptions fail closed without exposing error bodies',async()=>{
 const f=fixture();assert.throws(()=>createIsolatedAwsGuard({...f,versions:{...f.versions,media:'$LATEST'}}),/CONTEXT_REQUIRED/);
 f.mutate(()=>f.setClock(100000));await assert.rejects(createIsolatedAwsGuard(f)(),/MANIFEST_REQUIRED/);
 const g=fixture();await assert.rejects(createIsolatedAwsGuard({...g,aws:async()=>{throw Error('PRIVATE_PROVIDER_BODY');}})(),{message:'ISOLATED_AWS_METADATA_UNAVAILABLE'});
});
test('scoped CLI read transport executes complete guard with private request files and isolated environment',async()=>{
 const fs=require('node:fs/promises'),path=require('node:path'),f=fixture(),files=[];
 const commands={'get-caller-identity':'GetCallerIdentity','get-queue-attributes':'GetQueueAttributes','list-queue-tags':'ListQueueTags','get-function':'GetFunction','list-event-source-mappings':'ListEventSourceMappings'};
 const transport=createIsolatedAwsTransport({...f,env:{PATH:'fixture',HOME:'fixture',AWS_PROFILE:'approved',CLOUDFLARE_API_TOKEN:'must-not-forward',NODE_OPTIONS:'must-not-forward'},execute:async(program,args,options)=>{
  assert.equal(program,'aws');assert.equal(options.env.AWS_PROFILE,'approved');assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(options.env.NODE_OPTIONS,undefined);assert.ok(args.includes('--no-paginate'));
  const file=args.at(-1).slice(7);files.push(file);const handle=await fs.open(file,require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);let input;
  try{assert.equal((await handle.stat()).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);input=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
  return{stdout:JSON.stringify(await f.aws(args[0],commands[args[1]],input))};
 }});
 assert.deepEqual(await createIsolatedAwsGuard({...f,aws:transport})(),{awsConfigurationVerified:true,sharedProductionExecutionRole:true});assert.equal(files.length,19);for(const file of files)await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('metadata transport refuses production resources, arbitrary operations and changed qualifiers before CLI',async()=>{
 const f=fixture(),aws=createIsolatedAwsTransport({...f,execute:()=>assert.fail('CLI ran')});
 for(const [service,command,input] of [['ssm','GetParameter',{Name:'/videoq/prod/app'}],['lambda','Invoke',{}],['lambda','GetFunction',{FunctionName:'videoq-worker-prod',Qualifier:'1'}],['lambda','GetFunction',{FunctionName:'arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-isolated-'+f.manifest.nonce+'-worker-media',Qualifier:'2'}],['sqs','GetQueueAttributes',{QueueUrl:'https://sqs.ap-northeast-1.amazonaws.com/257240362763/videoq-worker-prod',AttributeNames:['All']}],['sqs','SendMessage',{}]])await assert.rejects(aws(service,command,input),/READ_REFUSED/);
 f.setClock(100000);await assert.rejects(aws('sts','GetCallerIdentity',{}),/MANIFEST_REQUIRED/);
});
