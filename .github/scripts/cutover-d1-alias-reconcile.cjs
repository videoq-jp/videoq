// Complete an already-applied legacy handoff after validating Cloudflare's
// redundant D1 ID alias. No runtime configuration, admission or DB rows change.
'use strict';
const {createHash}=require('node:crypto');
const {assertTransferContext,TARGET,TABLE}=require('./cutover-final-context.cjs');
const {apiFingerprint,rawApiFingerprint,desiredEnvironment}=require('./cutover-backend-handoff.cjs');
const LEGACY_SOURCE='c904d2b6c3a1d020272b8b2012ee1f75d5a4d34c';
const FUNCTIONS=['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'];
const BASE='accounts/'+TARGET.accountId+'/workers/scripts/videoq-api';
const sha=text=>createHash('sha256').update(text).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):v;
const hash=v=>sha(JSON.stringify(canonical(v)));
function bound(row,key){const text=row[key]?.S;if(typeof text!=='string'||sha(text)!==row[key+'_sha256']?.S)throw Error('ALIAS_RECONCILIATION_PROOF_CHANGED');return JSON.parse(text);}
async function reconcileLegacyD1Alias({run,source,operatorSource,aws,github,cloudflare,fetcher=fetch,verifyContext=assertTransferContext}){
 if(source!==LEGACY_SOURCE||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(operatorSource??'')||operatorSource===source)throw Error('FIXED_LEGACY_HANDOFF_REQUIRED');
 const read=async()=>(await aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:'run#'+run}},ConsistentRead:true})).Item;
 async function proof(){
  const p=await verifyContext({run,source,aws,github,cloudflare,fetcher,expectedBackend:'d1'});
  const transfer=bound(p.row,'transfer_verify_receipt'),auth=bound(p.row,'internal_auth_receipt'),intent=bound(p.row,'backend_handoff_intent');
  if(transfer.version!==1||transfer.runId!==run||transfer.sourceSha!==source||transfer.phase!=='verify'||transfer.complete!==true||hash(transfer.target)!==hash(TARGET)||auth.version!==1||auth.runId!==run||auth.sourceSha!==source||auth.admissionPaused!==true||auth.workerProfilesChanged!==false||auth.apiBackendChanged!==false||intent.version!==1||intent.runId!==run||intent.sourceSha!==source||intent.apiBeforeVersion!==auth.apiVersion||!Array.isArray(intent.profiles)||intent.profiles.length!==3)throw Error('VERIFIED_LEGACY_HANDOFF_REQUIRED');
  return{...p,intent};
 }
 async function observe(p){
  const settings=await cloudflare('GET',BASE+'/settings'),db=settings.bindings.filter(b=>b.name==='DB');
  if(db.length!==1||db[0].type!=='d1'||db[0].id!==TARGET.databaseId||db[0].database_id!==TARGET.databaseId||settings.bindings.some(b=>b.name==='HYPERDRIVE'||b.name==='MIGRATION_ALLOW_CLOUD_POSTGRES')||settings.bindings.find(b=>b.name==='DEPLOYMENT_EDITION')?.text!=='cloud'||settings.bindings.find(b=>b.name==='PERSISTENCE_BACKEND')?.text!=='d1'||settings.bindings.find(b=>b.name==='MIGRATION_TRAFFIC_STATE')?.text!=='paused'||settings.bindings.filter(b=>b.name==='WORKER_INTERNAL_API_SECRET'&&b.type==='secret_text').length!==1)throw Error('EXACT_PAUSED_D1_ALIAS_REQUIRED');
  for(const [name,index]of [['SCENE_VECTORIZE_1536',TARGET.largeIndex],['SCENE_VECTORIZE_768',TARGET.smallIndex]])if(settings.bindings.filter(b=>b.name===name&&b.type==='vectorize'&&b.index_name===index).length!==1)throw Error('FIXED_VECTOR_TARGET_REQUIRED');
  if(apiFingerprint(settings)!==p.intent.apiAfter||rawApiFingerprint(settings)===p.intent.apiAfter)throw Error('ONLY_REDUNDANT_D1_ALIAS_CAN_RECONCILE');
  const deployment=await cloudflare('GET',BASE+'/deployments'),latest=await cloudflare('GET',BASE+'/versions?per_page=1'),active=deployment.deployments?.[0];
  if(active?.versions?.length!==1||active.versions[0].percentage!==100||active.versions[0].version_id!==latest.items?.[0]?.id||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(active.versions[0].version_id??''))throw Error('STABLE_D1_VERSION_REQUIRED');
  const profiles=[];
  for(const [i,name]of FUNCTIONS.entries()){
   const intended=p.intent.profiles[i],value=await aws('lambda','GetFunctionConfiguration',{FunctionName:name});
   if(intended.name!==name||hash(desiredEnvironment(intended.original))!==hash(intended.desired)||value.FunctionName!==name||value.FunctionArn!=='arn:aws:lambda:ap-northeast-1:257240362763:function:'+name||value.PackageType!=='Image'||value.State!=='Active'||value.LastUpdateStatus!=='Successful'||!value.RevisionId||value.CodeSha256!==intended.codeSha256||hash(value.Environment?.Variables)!==hash(intended.desired))throw Error('EXACT_APPLIED_WORKER_PROFILE_REQUIRED');
   profiles.push({name,revision:value.RevisionId,codeSha256:value.CodeSha256,environmentSha256:hash(value.Environment.Variables)});
  }
  return{apiVersion:active.versions[0].version_id,apiBindingsSha256:rawApiFingerprint(settings),profiles};
 }
 let p=await proof(),observed=await observe(p);
 const receipt={version:1,runId:run,sourceSha:source,...observed,target:TARGET,admissionPaused:true,productionSafe:false};
 // Preserve the original raw fingerprint contract for the pinned legacy finalizer.
 const audit={version:1,runId:run,sourceSha:source,operatorSourceSha:operatorSource,originalIntentSha256:p.row.backend_handoff_intent_sha256.S,intendedApiBindingsSha256:p.intent.apiAfter,observedRawApiBindingsSha256:observed.apiBindingsSha256,databaseId:TARGET.databaseId,duplicateAliasValidated:true,runtimeConfigurationChanged:false,admissionChanged:false};
 const fields={backend_handoff_receipt:{S:JSON.stringify(receipt)},backend_alias_reconciliation_receipt:{S:JSON.stringify(audit)}};
 for(const [key,value]of Object.entries({...fields}))fields[key+'_sha256']={S:sha(value.S)};
 if(p.row.backend_handoff_receipt){
  for(const [key,value]of Object.entries(fields))if(p.row[key]?.S!==value.S)throw Error('EXISTING_RECONCILIATION_CHANGED');
  return{reconciled:true,admissionPaused:true,productionSafe:false};
 }
 const before=p;p=await proof();
 if(p.row.cutover_revision.N!==before.row.cutover_revision.N||p.row.backend_handoff_intent.S!==before.row.backend_handoff_intent.S||hash(await observe(p))!==hash(observed))throw Error('LEGACY_HANDOFF_CHANGED_DURING_RECONCILIATION');
 const r=p.row,next={N:String(Number(r.cutover_revision.N)+1)},names={'#revision':'cutover_revision'},values={':execution':r.execution_arn,':source':r.source_sha,':previous':r.cutover_revision,':next':next,':true':{BOOL:true},':false':{BOOL:false},':phase':{S:'consumers-paused'},':fenced':{S:'fenced'},':intent':r.backend_handoff_intent,':transfer':r.transfer_verify_receipt,':auth':r.internal_auth_receipt};
 const sets=['#revision=:next'];Object.entries(fields).forEach(([key,value],i)=>{names['#f'+i]=key;values[':f'+i]=value;sets.push('#f'+i+'=:f'+i);});
 const input={TransactItems:[{Update:{TableName:TABLE,Key:{pk:{S:'run#'+run}},UpdateExpression:'SET '+sets.join(','),ConditionExpression:'execution_arn=:execution AND source_sha=:source AND #revision=:previous AND database_mutations_started=:true AND release_requested=:false AND cutover_phase=:phase AND postgres_fence_state=:fenced AND api_pause_verified=:true AND api_admission_restored=:false AND consumer_admission_restored=:false AND deployment_admission_restored=:false AND backend_handoff_intent=:intent AND transfer_verify_receipt=:transfer AND internal_auth_receipt=:auth AND attribute_not_exists(backend_handoff_receipt) AND attribute_not_exists(backend_alias_reconciliation_receipt)',ExpressionAttributeNames:names,ExpressionAttributeValues:values}},{ConditionCheck:{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn=:execution AND #kind=:kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':r.execution_arn,':kind':{S:'cutover-hold'}}}}]};
 const saved=async()=>{const row=await read();return row?.cutover_revision?.N===next.N&&Object.entries(fields).every(([key,value])=>row[key]?.S===value.S);};
 try{await aws('ddb','TransactWriteItems',input);}catch(error){if(!await saved())throw error;}
 if(!await saved())throw Error('RECONCILIATION_RECEIPT_NOT_DURABLE');
 await proof();
 return{reconciled:true,admissionPaused:true,productionSafe:false};
}
module.exports={LEGACY_SOURCE,reconcileLegacyD1Alias};
