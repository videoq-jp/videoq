// Serial local-main handoff. This changes only fixed profiles and Worker metadata
// while all application admission is closed; it never resumes or unlocks.
'use strict';
const {createHash}=require('node:crypto');
const {TARGET,TABLE,assertTransferContext}=require('./cutover-final-context.cjs');
const {publicApiState}=require('./cutover-consumer-control.cjs');
const functions=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'];
const base='accounts/'+TARGET.accountId+'/workers/scripts/videoq-api';
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,stable(value)])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
function desiredEnvironment(original){
 if(!original||Object.values(original).some(v=>typeof v!=='string')||Object.keys(original).some(k=>/SECRET|TOKEN|PASSWORD|KEY|DATABASE_URL/.test(k)))throw Error('INLINE_WORKER_SECRET_FORBIDDEN');
 if(original.APP_PARAM_NAME!=='/videoq/prod/app'||original.DB_PARAM_NAME!=='/videoq/prod/worker-db')throw Error('FIXED_WORKER_PARAMETERS_REQUIRED');
 const result={...original,DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',WORKER_INTERNAL_API_ORIGIN:'https://videoq.jp'};
 delete result.MIGRATION_ALLOW_CLOUD_POSTGRES;return result;
}
function desiredBindings(settings){
 const replace=new Set(['DB','HYPERDRIVE','DEPLOYMENT_EDITION','PERSISTENCE_BACKEND','MIGRATION_ALLOW_CLOUD_POSTGRES','SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768']);
 if(!Array.isArray(settings?.bindings)||new Set(settings.bindings.map(v=>v.name)).size!==settings.bindings.length||settings.bindings.find(v=>v.name==='MIGRATION_TRAFFIC_STATE')?.text!=='paused'||settings.bindings.filter(v=>v.name==='WORKER_INTERNAL_API_SECRET'&&v.type==='secret_text').length!==1)throw Error('PAUSED_AUTHENTICATED_API_REQUIRED');
 return [...settings.bindings.filter(v=>!replace.has(v.name)).map(v=>({name:v.name,type:'inherit'})),{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'PERSISTENCE_BACKEND',type:'plain_text',text:'d1'},{name:'DB',type:'d1',id:TARGET.databaseId},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:TARGET.largeIndex},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:TARGET.smallIndex}];
}
function rawApiFingerprint(settings){
 return hash(settings.bindings.map(v=>v.type.startsWith('secret_')?{name:v.name,type:v.type}:v).sort((a,b)=>a.name.localeCompare(b.name)));
}
function apiFingerprint(settings){
 return rawApiFingerprint({...settings,bindings:settings.bindings.map(binding=>{
  if(binding.type!=='d1'||!Object.hasOwn(binding,'database_id'))return binding;
  if(typeof binding.id!=='string'||!binding.id||binding.database_id!==binding.id)throw Error('D1_BINDING_ID_ALIAS_MISMATCH');
  const {database_id:_,...canonical}=binding;return canonical;
 })});
}
async function handoffBackend({run,source,aws,github,cloudflare,fetcher=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),verifyContext=assertTransferContext}){
 const get=pk=>aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:pk}},ConsistentRead:true});
 async function proof(){
  const row=(await get('run#'+run)).Item;
  const observed=publicApiState(await cloudflare('GET',base+'/settings')),vars=JSON.parse(observed.serialized).vars;
  const backend=vars.PERSISTENCE_BACKEND??(vars.DEPLOYMENT_EDITION==='cloud'?'d1':'postgres');
  if(backend==='d1'&&!row?.backend_handoff_intent)throw Error('UNOWNED_BACKEND_ACTIVATION');
  const context=await verifyContext({run,source,aws,github,cloudflare,fetcher,expectedBackend:backend});
  for(const field of ['transfer_verify_receipt','internal_auth_receipt']){
   const value=context.row[field]?.S;if(typeof value!=='string'||createHash('sha256').update(value).digest('hex')!==context.row[field+'_sha256']?.S)throw Error('VERIFIED_HANDOFF_PREREQUISITE_REQUIRED');
   const receipt=JSON.parse(value);if(receipt.runId!==run||receipt.sourceSha!==source||receipt.version!==1||(field==='transfer_verify_receipt'?(receipt.complete!==true||receipt.phase!=='verify'||JSON.stringify(receipt.target)!==JSON.stringify(TARGET)):(receipt.admissionPaused!==true||receipt.workerProfilesChanged!==false||receipt.apiBackendChanged!==false)))throw Error('VERIFIED_HANDOFF_PREREQUISITE_REQUIRED');
  }
  return context;
 }
 async function save(context,field,value){
  const row=context.row,text=JSON.stringify(value),sha=createHash('sha256').update(text).digest('hex'),next=String(Number(row.cutover_revision.N)+1);
  const input={TableName:TABLE,Key:{pk:{S:'run#'+run}},UpdateExpression:'SET #field=:value,#sha=:sha,#revision=:next',ConditionExpression:'execution_arn=:execution AND source_sha=:source AND #revision=:previous AND release_requested=:false AND database_mutations_started=:true AND cutover_phase=:phase AND postgres_fence_state=:fenced AND transfer_verify_receipt=:transfer AND internal_auth_receipt=:auth AND api_admission_restored=:false AND consumer_admission_restored=:false AND deployment_admission_restored=:false AND (attribute_not_exists(#field) OR (#field=:value AND #sha=:sha))',ExpressionAttributeNames:{'#field':field,'#sha':field+'_sha256','#revision':'cutover_revision'},ExpressionAttributeValues:{':value':{S:text},':sha':{S:sha},':previous':row.cutover_revision,':next':{N:next},':execution':row.execution_arn,':source':row.source_sha,':false':{BOOL:false},':true':{BOOL:true},':phase':{S:'consumers-paused'},':fenced':{S:'fenced'},':transfer':row.transfer_verify_receipt,':auth':row.internal_auth_receipt}};
  try{await aws('ddb','TransactWriteItems',{TransactItems:[{Update:input},{ConditionCheck:{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn=:execution AND #kind=:kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':row.execution_arn,':kind':{S:'cutover-hold'}}}}]});}catch(error){const found=(await proof()).row;if(found.cutover_revision.N!==next||found[field]?.S!==text||found[field+'_sha256']?.S!==sha)throw error;}
  const found=(await proof()).row;if(found.cutover_revision.N!==next||found[field]?.S!==text||found[field+'_sha256']?.S!==sha)throw Error('HANDOFF_INTENT_NOT_DURABLE');
 }
 async function stableApi(){
  for(let attempt=0;attempt<20;attempt++){
   const deployment=await cloudflare('GET',base+'/deployments'),latest=await cloudflare('GET',base+'/versions?per_page=1'),active=deployment.deployments?.[0];
   if(active?.versions?.length===1&&active.versions[0].percentage===100&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(active.versions[0].version_id??'')&&active.versions[0].version_id===latest.items?.[0]?.id)return active.versions[0].version_id;
   await sleep(1000);
  }throw Error('STABLE_API_VERSION_REQUIRED');
 }
 async function profile(name){const value=await aws('lambda','GetFunctionConfiguration',{FunctionName:name});if(value.FunctionName!==name||value.FunctionArn!=='arn:aws:lambda:ap-northeast-1:257240362763:function:'+name||value.State!=='Active'||value.LastUpdateStatus!=='Successful'||!value.RevisionId||!value.CodeSha256||value.PackageType!=='Image')throw Error('STABLE_FIXED_WORKER_REQUIRED');desiredEnvironment(value.Environment?.Variables);return value;}
 let context=await proof(),intent;
 if(context.row.backend_handoff_intent){
  const text=context.row.backend_handoff_intent.S;if(createHash('sha256').update(text).digest('hex')!==context.row.backend_handoff_intent_sha256?.S)throw Error('HANDOFF_INTENT_CHANGED');intent=JSON.parse(text);
 }else{
  const apiBeforeVersion=await stableApi();if(apiBeforeVersion!==JSON.parse(context.row.internal_auth_receipt.S).apiVersion)throw Error('API_CODE_VERSION_CHANGED');
  const settings=await cloudflare('GET',base+'/settings');desiredBindings(settings);
  const profiles=[];for(const name of functions){const value=await profile(name);profiles.push({name,revision:value.RevisionId,codeSha256:value.CodeSha256,original:value.Environment.Variables,desired:desiredEnvironment(value.Environment.Variables)});}
  const after={...settings,bindings:desiredBindings(settings).map(v=>v.type==='inherit'?settings.bindings.find(b=>b.name===v.name):v)};
  intent={version:1,runId:run,sourceSha:source,apiBeforeVersion,apiBefore:apiFingerprint(settings),apiAfter:apiFingerprint(after),profiles};await save(await proof(),'backend_handoff_intent',intent);
 }
 if(intent.version!==1||intent.runId!==run||intent.sourceSha!==source||!Array.isArray(intent.profiles)||intent.profiles.length!==functions.length||intent.profiles.some((v,i)=>v.name!==functions[i]||hash(desiredEnvironment(v.original))!==hash(v.desired)))throw Error('HANDOFF_INTENT_CHANGED');
 const finalProfiles=[];
 for(const item of intent.profiles){
  await proof();let value=await profile(item.name);if(value.CodeSha256!==item.codeSha256)throw Error('WORKER_CODE_CHANGED');
  if(hash(value.Environment.Variables)!==hash(item.desired)){
   if(value.RevisionId!==item.revision||hash(value.Environment.Variables)!==hash(item.original))throw Error('UNRELATED_WORKER_CHANGE');
   await proof();let failure;try{await aws('lambda','UpdateFunctionConfiguration',{FunctionName:item.name,RevisionId:value.RevisionId,Environment:{Variables:item.desired}});}catch(error){failure=error;}
   let stable=false;for(let i=0;i<90;i++){await proof();const current=await aws('lambda','GetFunctionConfiguration',{FunctionName:item.name});if(current.LastUpdateStatus==='Successful'&&current.State==='Active'){value=await profile(item.name);stable=true;break;}if(current.LastUpdateStatus==='Failed')break;await sleep(1000);}
   if(!stable||value.CodeSha256!==item.codeSha256||hash(value.Environment.Variables)!==hash(item.desired)){if(failure)throw failure;throw Error('WORKER_HANDOFF_INCOMPLETE');}
  }
  finalProfiles.push({name:item.name,revision:value.RevisionId,codeSha256:value.CodeSha256,environmentSha256:hash(value.Environment.Variables)});
 }
 const settings=await cloudflare('GET',base+'/settings'),bindings=desiredBindings(settings),selected=JSON.parse(publicApiState(settings).serialized).vars;
 if(selected.PERSISTENCE_BACKEND!=='d1'){
  if(apiFingerprint(settings)!==intent.apiBefore||await stableApi()!==intent.apiBeforeVersion)throw Error('UNRELATED_API_CHANGE');await proof();let failure;
  try{await cloudflare('PATCH',base+'/settings',{bindings});}catch(error){failure=error;}
  try{await proof();}catch(error){if(failure)throw failure;throw error;}
 }
 const version=await stableApi();
 const final=await proof();
 // Bind every unchanged nonsecret setting too; a partial metadata patch cannot
 // be treated as a successful handoff merely because its backend is D1.
 const actual=await cloudflare('GET',base+'/settings');if(apiFingerprint(actual)!==intent.apiAfter)throw Error('UNRELATED_API_CHANGE');
 if(actual.bindings.some(v=>v.name==='HYPERDRIVE'||v.name==='MIGRATION_ALLOW_CLOUD_POSTGRES')||actual.bindings.find(v=>v.name==='DEPLOYMENT_EDITION')?.text!=='cloud'||actual.bindings.find(v=>v.name==='SCENE_VECTORIZE_1536')?.index_name!==TARGET.largeIndex||actual.bindings.find(v=>v.name==='SCENE_VECTORIZE_768')?.index_name!==TARGET.smallIndex)throw Error('BACKEND_HANDOFF_INCOMPLETE');
 const receipt={version:1,runId:run,sourceSha:source,apiVersion:version,apiBindingsSha256:apiFingerprint(actual),target:TARGET,profiles:finalProfiles,admissionPaused:true,productionSafe:false};
 await save(final,'backend_handoff_receipt',receipt);return{backend:'d1',admissionPaused:true,productionSafe:false};
}
module.exports={desiredEnvironment,desiredBindings,apiFingerprint,rawApiFingerprint,handoffBackend};
