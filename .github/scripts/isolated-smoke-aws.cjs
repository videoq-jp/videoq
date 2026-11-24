// Read-only configuration proof. The fixed existing execution role retains its
// production permissions; this does not claim IAM isolation or image provenance.
const {createHash}=require('node:crypto');
const {validateIsolatedSmokeManifest}=require('./isolated-smoke-target.cjs');
const ACCOUNT='257240362763',REGION='ap-northeast-1',GROUPS=['media','search','account'];
const ROLE=`arn:aws:iam::${ACCOUNT}:role/videoq-worker-prod`;
const SECRETS=['WORKER_INTERNAL_API_SECRET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'];
const digest=value=>createHash('sha256').update(value).digest('hex');
function createIsolatedAwsGuard({manifest,versions,imageDigest,secretSha256,aws,now=Date.now}){
 const context=Object.freeze(structuredClone(manifest)),target=validateIsolatedSmokeManifest(context,now());
 versions=Object.freeze({...versions});secretSha256=Object.freeze({...secretSha256});
 if(typeof aws!=='function'||!/^[a-f0-9]{64}$/.test(imageDigest??'')||Object.keys(versions).sort().join(',')!=='account,media,search'||GROUPS.some(g=>!/^[1-9][0-9]{0,9}$/.test(versions[g]??''))||Object.keys(secretSha256).sort().join(',')!==[...SECRETS].sort().join(',')||SECRETS.some(k=>!/^[a-f0-9]{64}$/.test(secretSha256[k]??'')))throw Error('ISOLATED_AWS_CONTEXT_REQUIRED');
 const prefix='videoq-isolated-'+target.nonce+'-',queueName=g=>prefix+g,queueArn=g=>`arn:aws:sqs:${REGION}:${ACCOUNT}:${queueName(g)}`,queueUrl=g=>`https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${queueName(g)}`,functionName=g=>prefix+'worker-'+g,functionArn=g=>`arn:aws:lambda:${REGION}:${ACCOUNT}:function:${functionName(g)}`;
 const image=`${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/videoq-worker-prod@sha256:${imageDigest}`;
 const refused=()=>{throw Error('ISOLATED_AWS_CONFIGURATION_DRIFT');};
 function policy(text,arn,required){
  if(text===undefined)refused();let parsed;try{parsed=JSON.parse(text);}catch{refused();}
  if(!Array.isArray(parsed?.Statement)||parsed.Statement.length!==(required?2:1))refused();
  const denied=parsed.Statement.filter(v=>v.Effect==='Deny');
  if(denied.length!==1||denied[0].Principal!=='*'||denied[0].Action!=='sqs:*'||denied[0].Resource!==arn||JSON.stringify(denied[0].Condition)!==JSON.stringify({Bool:{'aws:SecureTransport':'false'}})||denied[0].NotPrincipal||denied[0].NotAction||denied[0].NotResource)refused();
  const allowed=parsed.Statement.filter(v=>v.Effect==='Allow');if(allowed.length!==(required?1:0))refused();if(!required)return;const row=allowed[0];
  const actions=['sqs:SendMessage','sqs:ReceiveMessage','sqs:DeleteMessage','sqs:ChangeMessageVisibility','sqs:GetQueueAttributes','sqs:GetQueueUrl'];
  if(row.Effect!=='Allow'||row.Principal?.AWS!==ROLE||Object.keys(row.Principal).join(',')!=='AWS'||row.Resource!==arn||!Array.isArray(row.Action)||row.Action.length!==actions.length||new Set(row.Action).size!==actions.length||row.Action.some(v=>!actions.includes(v))||row.Condition||row.NotPrincipal||row.NotResource||row.NotAction)refused();
 }
 async function queue(group,dlq=false){
  const name=group+(dlq?'-dlq':''),url=queueUrl(name),arn=queueArn(name);
  const [attributes,tags]=await Promise.all([aws('sqs','GetQueueAttributes',{QueueUrl:url,AttributeNames:['QueueArn','RedrivePolicy','Policy','VisibilityTimeout']}),aws('sqs','ListQueueTags',{QueueUrl:url})]);
  if(attributes.Attributes?.QueueArn!==arn||tags.Tags?.['videoq-operation']!=='isolated-e2e'||tags.Tags?.['videoq-nonce']!==target.nonce)refused();policy(attributes.Attributes.Policy,arn,!dlq);
  if(dlq){if(attributes.Attributes.RedrivePolicy!==undefined)refused();return;}
  let redrive;try{redrive=JSON.parse(attributes.Attributes.RedrivePolicy);}catch{refused();}
  const visibility=Number(attributes.Attributes.VisibilityTimeout);
  if(redrive.deadLetterTargetArn!==queueArn(group+'-dlq')||!Number.isSafeInteger(Number(redrive.maxReceiveCount))||Number(redrive.maxReceiveCount)<1||Number(redrive.maxReceiveCount)>5||!Number.isSafeInteger(visibility)||visibility<960)refused();
  return visibility;
 }
 async function worker(group){
  const [found,mapping]=await Promise.all([aws('lambda','GetFunction',{FunctionName:functionArn(group),Qualifier:versions[group]}),aws('lambda','ListEventSourceMappings',{FunctionName:functionArn(group),MaxItems:100})]);
  const config=found.Configuration,env=config?.Environment?.Variables;
  if(config?.FunctionName!==functionName(group)||config.FunctionArn!==functionArn(group)+':'+versions[group]||config.Version!==versions[group]||config.Role!==ROLE||config.PackageType!=='Image'||found.Code?.ResolvedImageUri!==image||config.State!=='Active'||config.Architectures?.join(',')!=='arm64'||!Number.isSafeInteger(config.Timeout)||config.Timeout<30||config.Timeout>900||!env||config.Environment.Error||config.ImageConfigResponse?.Error||config.ImageConfigResponse?.ImageConfig?.Command?.join(',')!=='handler.handler'||config.ImageConfigResponse.ImageConfig.EntryPoint?.length||config.ImageConfigResponse.ImageConfig.WorkingDirectory)refused();
  if(Object.keys(env).some(k=>/(?:PARAM_NAME|SECRET_ARN)$/.test(k)||/^(?:DATABASE_URL|DB_SECRET|PG[A-Z_]*|OPENAI_API_KEY|EMBEDDING_API_KEY|CLOUDFLARE_API_TOKEN|AWS_ENDPOINT_URL.*|SQS_ENDPOINT_URL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/.test(k)))refused();
  const expected={DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',WORKER_INTERNAL_API_ORIGIN:target.origin,FRONTEND_URL:target.origin,USE_S3_STORAGE:'true',R2_BUCKET_NAME:target.bucket,R2_S3_ENDPOINT:`https://${target.accountId}.r2.cloudflarestorage.com`,R2_S3_REGION:'auto',SQS_QUEUE_URL:queueUrl('media'),SQS_QUEUE_NAME:queueName('media'),SQS_MEDIA_QUEUE_URL:queueUrl('media'),SQS_SEARCH_QUEUE_URL:queueUrl('search'),SQS_ACCOUNT_QUEUE_URL:queueUrl('account'),EMBEDDING_PROVIDER:'workers-ai',EMBEDDING_MODEL:'@cf/google/embeddinggemma-2',EMBEDDING_PROFILE:'embeddinggemma2',WHISPER_BACKEND:'workers-ai',ENABLE_HEAVY_PIPELINE:'true',VIDEO_VISUAL_ENABLED:'true',MEDIA_PROCESS_MEMORY_LIMIT_MB:'2048',MEDIA_PROCESS_CPU_TIME_LIMIT_SECONDS:'300',FFMPEG_PROCESS_TIMEOUT_SECONDS:'600',MEDIA_PROCESS_OUTPUT_FILE_SIZE_LIMIT_MB:'1024'};
  if(Object.keys(env).some(k=>!Object.hasOwn(expected,k)&&!SECRETS.includes(k))||Object.entries(expected).some(([k,v])=>env[k]!==v)||SECRETS.some(k=>typeof env[k]!=='string'||!env[k]||digest(env[k])!==secretSha256[k]))refused();
  if(mapping.NextMarker||!Array.isArray(mapping.EventSourceMappings)||mapping.EventSourceMappings.length!==1)refused();
  const row=mapping.EventSourceMappings[0];
  if(row.FunctionArn!==functionArn(group)+':'+versions[group]||row.EventSourceArn!==queueArn(group)||row.State!=='Enabled'||row.BatchSize!==1||row.FunctionResponseTypes?.join(',')!=='ReportBatchItemFailures')refused();
  return config.Timeout;
 }
 return async()=>{
  try{
  validateIsolatedSmokeManifest(context,now());const identity=await aws('sts','GetCallerIdentity',{});if(identity.Account!==ACCOUNT)refused();
  await Promise.all(GROUPS.map(async group=>{const [visibility,timeout]=await Promise.all([queue(group),worker(group),queue(group,true)]);if(visibility<Math.max(timeout*6,900+timeout+60))refused();}));
  validateIsolatedSmokeManifest(context,now());return{awsConfigurationVerified:true,sharedProductionExecutionRole:true};
  }catch(error){if(/^ISOLATED_(?:AWS|SMOKE)_[A-Z_]+$/.test(error?.message??''))throw error;throw Error('ISOLATED_AWS_METADATA_UNAVAILABLE');}
 };
}
module.exports={createIsolatedAwsGuard};
