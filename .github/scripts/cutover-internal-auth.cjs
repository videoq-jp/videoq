// Fixed AWS-only provisioning. Never reads DB administration credentials and
// never changes API backend, worker admission or any user authentication key.
const {randomBytes,createHash}=require('node:crypto');
const m=require('./neon-admin.cjs');
const {createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs');
const {publicApiState}=require('./cutover-consumer-control.cjs');
const {createConsumerControl,validateConsumerPlan}=require('./cutover-sqs-consumers.cjs');
const {verifyProductionTraffic}=require('./cutover-owned-api-traffic.cjs');
const {TARGET,TABLE}=require('./cutover-final-context.cjs');
const APP='/videoq/prod/app',KEY='/videoq/security/prod/worker-internal-api';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const textHash=v=>createHash('sha256').update(v).digest('hex');
const others=value=>{const {WORKER_INTERNAL_API_SECRET:_,...rest}=value;return hash(rest);};
const secretValid=value=>typeof value==='string'&&value.length>=32&&value.length<=4096&&!/[\r\n\0]/.test(value);
function metadataHash(settings){const {annotations:_,bindings,...rest}=settings;return hash({...rest,bindings:bindings.filter(b=>b.name!=='WORKER_INTERNAL_API_SECRET').map(b=>b.type.startsWith('secret_')?{name:b.name,type:b.type}:b).sort((a,b)=>a.name.localeCompare(b.name))});}
async function provisionInternalAuth({env=process.env,aws=m.aws,readParameter=m.readParameter,fetcher=fetch,random=()=>randomBytes(32).toString('hex'),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const run=env.MAINTENANCE_RUN_ID,source=env.MAINTENANCE_SOURCE_SHA,action=env.MAINTENANCE_HANDOFF_ACTION_ID;
 if(env.VIDEOQ_CUTOVER_FINAL_HANDOFF!=='true'||env.MAINTENANCE_KIND!=='cutover-hold'||env.MAINTENANCE_STAGE!=='cutover-internal-auth'||env.MAINTENANCE_TABLE!==TABLE||env.GITHUB_ACTIONS||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{32}$/.test(action??'')||!/^[a-f0-9]{40}$/.test(source??'')||!/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-rotation-prod:[a-f0-9-]{36}$/.test(env.CODEBUILD_BUILD_ARN??''))throw Error('FIXED_AWS_INTERNAL_AUTH_REQUIRED');
 const arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run,get=pk=>aws('dynamodb','get-item',{TableName:TABLE,Key:{pk:{S:pk}},ConsistentRead:true});
 let pinned;
 async function owned(){
  const [r,o]=await Promise.all([get('run#'+run),get('maintenance')]);const row=r.Item;
  if(row?.kind?.S!=='cutover-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==source||row.handoff_action_id?.S!==action||o.Item?.kind?.S!=='cutover-hold'||o.Item.execution_arn?.S!==arn||row.database_mutations_started?.BOOL!==true||row.release_requested?.BOOL!==false||row.cutover_phase?.S!=='consumers-paused'||row.postgres_fence_state?.S!=='fenced'||row.api_pause_verified?.BOOL!==true||['api_admission_restored','deployment_admission_restored','consumer_admission_restored'].some(k=>row[k]?.BOOL!==false)||!/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N??'')||!Number.isSafeInteger(Number(row.cutover_revision.N))||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('OWNED_INTERNAL_AUTH_PREPARATION_REQUIRED');
  const receipt=row.transfer_verify_receipt?.S;
  if(typeof receipt!=='string'||textHash(receipt)!==row.transfer_verify_receipt_sha256?.S)throw Error('VERIFIED_TRANSFER_REQUIRED');
  const verified=JSON.parse(receipt);if(verified.version!==1||verified.runId!==run||verified.sourceSha!==source||verified.phase!=='verify'||verified.complete!==true||verified.productionActive!==false||hash(verified.target)!==hash(TARGET)||pinned&&pinned!==receipt)throw Error('VERIFIED_TRANSFER_CHANGED');pinned=receipt;
  if(typeof row.consumer_plan?.S!=='string'||textHash(row.consumer_plan.S)!==row.consumer_plan_sha256?.S)throw Error('CONSUMER_PLAN_REQUIRED');return row;
 }
 let row=await owned();const plan=validateConsumerPlan(JSON.parse(row.consumer_plan.S));if(plan.scope.purpose!=='production')throw Error('PRODUCTION_CONSUMERS_REQUIRED');
 const cf=await readParameter('/videoq/security/prod/cutover-control');if(cf.CLOUDFLARE_ACCOUNT_ID!==TARGET.accountId)throw Error('FIXED_CLOUDFLARE_ACCOUNT_REQUIRED');
 const transport=createCloudflareTrafficTransport(cf.CLOUDFLARE_API_TOKEN,{fetcher}),base='accounts/'+TARGET.accountId+'/workers/scripts/videoq-api';
 const consumers=createConsumerControl((command,input)=>{if(command!=='ListEventSourceMappings')throw Error('READ_ONLY_ADMISSION_REQUIRED');return aws('lambda','list-event-source-mappings',input);});
 async function stopped(){
  const current=await owned();if(current.consumer_plan.S!==row.consumer_plan.S)throw Error('CONSUMER_PLAN_CHANGED');
  const settings=await transport('GET',base+'/settings'),state=publicApiState(settings),vars=JSON.parse(state.serialized).vars;
  if(state.traffic!=='paused'||(vars.PERSISTENCE_BACKEND??(vars.DEPLOYMENT_EDITION==='cloud'?'d1':'postgres'))!=='postgres'||!(await consumers.inspect(plan)).admissionPaused)throw Error('INTERNAL_AUTH_WRITERS_NOT_STOPPED');
  await verifyProductionTraffic(true,fetcher);return{row:current,settings};
 }
 async function stable(){for(let attempt=0;attempt<20;attempt++){await owned();const deployment=await transport('GET',base+'/deployments'),versions=await transport('GET',base+'/versions?per_page=1'),active=deployment.deployments?.[0];if(active?.versions?.length===1&&active.versions[0].percentage===100&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(active.versions[0].version_id??'')&&active.versions[0].version_id===versions.items?.[0]?.id)return active.versions[0].version_id;if(attempt<19)await sleep(1000);}throw Error('STABLE_API_VERSION_REQUIRED');}
 async function app(){const result=(await aws('ssm','get-parameter',{Name:APP,WithDecryption:true})).Parameter;if(result?.Type!=='SecureString'||!Number.isSafeInteger(result.Version)||result.Version<1)throw Error('SECURE_APP_PARAMETER_REQUIRED');const value=JSON.parse(result.Value);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('APP_OBJECT_REQUIRED');return{value,version:result.Version};}
 async function save(before,fields,immutable=false){
  const names={'#revision':'cutover_revision'},values={':execution':{S:arn},':source':{S:source},':action':{S:action},':previous':before.cutover_revision,':next':{N:String(Number(before.cutover_revision.N)+1)},':true':{BOOL:true},':false':{BOOL:false},':phase':{S:'consumers-paused'},':fenced':{S:'fenced'},':receipt':{S:pinned}},sets=['#revision=:next'];
  Object.entries(fields).forEach(([key,value],i)=>{names['#f'+i]=key;values[':f'+i]=value;sets.push('#f'+i+'=:f'+i);});
  try{await aws('dynamodb','transact-write-items',{TransactItems:[{Update:{TableName:TABLE,Key:{pk:{S:'run#'+run}},UpdateExpression:'SET '+sets.join(','),ConditionExpression:'execution_arn=:execution AND source_sha=:source AND handoff_action_id=:action AND #revision=:previous AND transfer_verify_receipt=:receipt AND database_mutations_started=:true AND release_requested=:false AND cutover_phase=:phase AND postgres_fence_state=:fenced AND api_pause_verified=:true AND api_admission_restored=:false AND consumer_admission_restored=:false AND deployment_admission_restored=:false'+(immutable?' AND ((attribute_not_exists(internal_auth_intent) AND attribute_not_exists(internal_auth_intent_sha256)) OR (internal_auth_intent=:f0 AND internal_auth_intent_sha256=:f1))':''),ExpressionAttributeNames:names,ExpressionAttributeValues:values}},{ConditionCheck:{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn=:execution AND #kind=:kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:'cutover-hold'}}}}]});}
  catch(error){const found=await owned();if(found.cutover_revision.N!==values[':next'].N||Object.entries(fields).some(([key,value])=>JSON.stringify(found[key])!==JSON.stringify(value)))throw error;}
  const found=await owned();if(found.cutover_revision.N!==values[':next'].N||Object.entries(fields).some(([key,value])=>JSON.stringify(found[key])!==JSON.stringify(value)))throw Error('AUTH_INTENT_NOT_DURABLE');return found;
 }
 let observed=await stopped(),current=await app(),intent,secret;
 if(row.internal_auth_intent){
  if(textHash(row.internal_auth_intent.S)!==row.internal_auth_intent_sha256?.S)throw Error('AUTH_INTENT_CHANGED');intent=JSON.parse(row.internal_auth_intent.S);
  secret=secretValid(current.value.WORKER_INTERNAL_API_SECRET)&&textHash(current.value.WORKER_INTERNAL_API_SECRET)===intent.secretSha256?current.value.WORKER_INTERNAL_API_SECRET:undefined;
  if(!secret){const existing=await readParameter(KEY);secret=existing.secret;}
 }else{
  if(observed.settings.bindings.some(b=>b.name==='WORKER_INTERNAL_API_SECRET'))throw Error('UNOWNED_INTERNAL_AUTH_BINDING');
  secret=current.value.WORKER_INTERNAL_API_SECRET;if(secret===null||secret==='')secret=undefined;
  if(secret!==undefined&&!secretValid(secret))throw Error('INVALID_EXISTING_INTERNAL_AUTH');
  if(!secret){
   let existing=await readParameter(KEY,true);
   if(!existing){try{const value=random();if(!/^[a-f0-9]{64}$/.test(value))throw Error('INVALID_GENERATED_AUTH');await aws('ssm','put-parameter',{Name:KEY,Type:'SecureString',Value:JSON.stringify({secret:value}),Overwrite:false});}catch{}existing=await readParameter(KEY);}
   secret=existing.secret;
  }
  if(!secretValid(secret))throw Error('PERSISTENT_INTERNAL_AUTH_REQUIRED');
  intent={version:1,runId:run,sourceSha:source,actionId:action,secretSha256:textHash(secret),originalAppVersion:current.version,otherAppFieldsSha256:others(current.value),apiMetadataSha256:metadataHash(observed.settings)};
  row=await save((await stopped()).row,{internal_auth_intent:{S:JSON.stringify(intent)},internal_auth_intent_sha256:{S:textHash(JSON.stringify(intent))}},true);
 }
 if(Object.keys(intent).length!==8||intent.version!==1||intent.runId!==run||intent.sourceSha!==source||intent.actionId!==action||!Number.isSafeInteger(intent.originalAppVersion)||intent.originalAppVersion<1||![intent.secretSha256,intent.otherAppFieldsSha256,intent.apiMetadataSha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||!secretValid(secret)||textHash(secret)!==intent.secretSha256)throw Error('AUTH_INTENT_CHANGED');
 observed=await stopped();current=await app();if(others(current.value)!==intent.otherAppFieldsSha256||metadataHash(observed.settings)!==intent.apiMetadataSha256)throw Error('UNRELATED_APP_OR_API_CHANGE');
 if(current.value.WORKER_INTERNAL_API_SECRET!==secret){
  if(![undefined,null,''].includes(current.value.WORKER_INTERNAL_API_SECRET))throw Error('APP_AUTH_CHANGED');
  const metadata=await aws('ssm','describe-parameters',{ParameterFilters:[{Key:'Name',Option:'Equals',Values:[APP]}]});
  if(metadata.Parameters?.length!==1||metadata.Parameters[0].Version!==current.version||!['Standard','Advanced'].includes(metadata.Parameters[0].Tier)||typeof metadata.Parameters[0].KeyId!=='string')throw Error('APP_PARAMETER_METADATA_CHANGED');
  await stopped();const latest=await app();if(latest.version!==current.version||hash(latest.value)!==hash(current.value))throw Error('APP_PARAMETER_CHANGED');
  let failure;try{await aws('ssm','put-parameter',{Name:APP,Type:'SecureString',Value:JSON.stringify({...current.value,WORKER_INTERNAL_API_SECRET:secret}),Overwrite:true,Tier:metadata.Parameters[0].Tier,KeyId:metadata.Parameters[0].KeyId,DataType:metadata.Parameters[0].DataType??'text'});}catch(error){failure=error;}
  const saved=await app();if(saved.value.WORKER_INTERNAL_API_SECRET!==secret||others(saved.value)!==intent.otherAppFieldsSha256){if(failure)throw failure;throw Error('APP_AUTH_WRITE_UNVERIFIED');}current=saved;
 }
 observed=await stopped();if(metadataHash(observed.settings)!==intent.apiMetadataSha256)throw Error('UNRELATED_API_CHANGE');await stable();
 // Every other binding is inherited, including Better Auth/encryption secrets.
 const bindings=observed.settings.bindings.filter(b=>b.name!=='WORKER_INTERNAL_API_SECRET').map(b=>({name:b.name,type:'inherit'}));bindings.push({name:'WORKER_INTERNAL_API_SECRET',type:'secret_text',text:secret});
 let failure;try{await transport('PATCH',base+'/settings',{bindings});}catch(error){failure=error;}
 const activeVersion=await stable(),after=await stopped();
 const binding=after.settings.bindings.filter(b=>b.name==='WORKER_INTERNAL_API_SECRET');if(binding.length!==1||binding[0].type!=='secret_text'||metadataHash(after.settings)!==intent.apiMetadataSha256){if(failure)throw failure;throw Error('INTERNAL_AUTH_BINDING_UNVERIFIED');}
 const saved=await app();if(saved.value.WORKER_INTERNAL_API_SECRET!==secret||others(saved.value)!==intent.otherAppFieldsSha256)throw Error('APP_AUTH_CHANGED');
 const receipt={version:1,runId:run,sourceSha:source,actionId:action,secretSha256:intent.secretSha256,appParameterVersion:saved.version,apiVersion:activeVersion,workerProfilesChanged:false,apiBackendChanged:false,admissionPaused:true};
 await save(after.row,{internal_auth_receipt:{S:JSON.stringify(receipt)},internal_auth_receipt_sha256:{S:textHash(JSON.stringify(receipt))}});
 return{internalAuthPrepared:true,workerProfilesChanged:false,apiBackendChanged:false,admissionPaused:true};
}
module.exports={provisionInternalAuth};
if(require.main===module)provisionInternalAuth().then(value=>console.log(JSON.stringify(value))).catch(()=>{console.error('INTERNAL_AUTH_PREPARATION_FAILED_KEEP_WRITERS_STOPPED');process.exitCode=1;});
