// Metadata-only traffic flag changes. Caller must freeze deployment automation,
// own the maintenance hold and persist the original plan before calling pause.
const {createHash,randomUUID}=require('node:crypto');
const account='12daec56fdba43f677f2766ee26a5a39',flag='MIGRATION_TRAFFIC_STATE';
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function target(scope){if(scope?.purpose==='production'&&Object.keys(scope).length===1)return'videoq-api';if(scope?.purpose==='isolated-rehearsal'&&Object.keys(scope).length===2&&/^[a-f0-9]{16}$/.test(scope.nonce??''))return'videoq-cutover-api-'+scope.nonce;throw Error('INVALID_API_TRAFFIC_SCOPE');}
function snapshot(settings){
 if(!settings||!Array.isArray(settings.bindings)||settings.bindings.some(b=>!b||typeof b.name!=='string'||!b.name||typeof b.type!=='string')||new Set(settings.bindings.map(b=>b.name)).size!==settings.bindings.length)throw Error('INVALID_API_TRAFFIC_SETTINGS');
 const traffic=settings.bindings.find(b=>b.name===flag);if(traffic&&(traffic.type!=='plain_text'||typeof traffic.text!=='string'))throw Error('INVALID_API_TRAFFIC_SETTINGS');
 const bindings=settings.bindings.filter(b=>b.name!==flag).map(b=>b.type.startsWith('secret_')?{name:b.name,type:b.type}:b).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 const {bindings:_,annotations:__,...rest}=settings;
 return{traffic:traffic?.text??null,bindingsHash:hash(bindings),settingsHash:hash(rest)};
}
function checked(plan){
 if(plan?.version!==1||plan.account!==account||plan.worker!==target(plan.scope)||!uuid.test(plan.operationId??'')||![null,'running'].includes(plan.originalTraffic)||!uuid.test(plan.originalVersion??'')||![plan.bindingsHash,plan.settingsHash].every(v=>/^[a-f0-9]{64}$/.test(v??'')))throw Error('INVALID_API_TRAFFIC_PLAN');return plan;
}
function createApiTrafficControl(request,{assertOwnership=async()=>{throw Error('API_TRAFFIC_OWNERSHIP_REQUIRED');},assertRestoreSafe=async()=>{throw Error('VERIFIED_API_RESTORE_HANDOFF_REQUIRED');},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const path=scope=>`accounts/${account}/workers/scripts/${target(scope)}`;
 async function stableOnce(scope){
  const base=path(scope),deployment=await request('GET',base+'/deployments'),latest=await request('GET',base+'/versions?per_page=1');const active=deployment?.deployments?.[0];
  if(!uuid.test(active?.id??'')||active.versions?.length!==1||active.versions[0].percentage!==100||!uuid.test(active.versions[0].version_id??'')||latest?.items?.[0]?.id!==active.versions[0].version_id)throw Error('API_TRAFFIC_VERSION_NOT_STABLE');
  const settings=await request('GET',base+'/settings'),again=await request('GET',base+'/deployments');
  if(again?.deployments?.[0]?.id!==active.id)throw Error('API_TRAFFIC_DEPLOYMENT_CHANGED');
  return{settings,state:snapshot(settings),version:active.versions[0].version_id};
 }
 async function stable(scope){
  for(let attempt=0;;attempt++){
   try{return await stableOnce(scope);}catch(error){
    if(attempt>=19||!['API_TRAFFIC_VERSION_NOT_STABLE','API_TRAFFIC_DEPLOYMENT_CHANGED'].includes(error.message))throw error;
    // Re-observe the same metadata; never re-send PATCH to settle propagation.
    await sleep(1000);
   }
  }
 }
 function matches(plan,state){if(state.bindingsHash!==plan.bindingsHash||state.settingsHash!==plan.settingsHash)throw Error('API_TRAFFIC_CONFIGURATION_CHANGED');}
 return{
  async prepare(scope){const {state,version}=await stable(scope);if(![null,'running'].includes(state.traffic))throw Error('API_TRAFFIC_ALREADY_PAUSED');return checked({version:1,operationId:randomUUID(),account,worker:target(scope),scope,originalTraffic:state.traffic,originalVersion:version,bindingsHash:state.bindingsHash,settingsHash:state.settingsHash});},
  async prepareRestore(plan,expectedBindingsHash){
   checked(plan);if(!/^[a-f0-9]{64}$/.test(expectedBindingsHash??''))throw Error('INVALID_API_TRAFFIC_HANDOFF');
   const proposed=checked({...plan,bindingsHash:expectedBindingsHash});
   await assertOwnership('restore',proposed);await assertRestoreSafe(proposed);
   const {state,version}=await stable(plan.scope);
   if(state.traffic!=='paused'||state.settingsHash!==plan.settingsHash||state.bindingsHash!==expectedBindingsHash)throw Error('API_TRAFFIC_HANDOFF_MISMATCH');
   await assertOwnership('restore',proposed);await assertRestoreSafe(proposed);
   return checked({...proposed,originalVersion:version});
  },
  async inspect(plan){checked(plan);const {state}=await stable(plan.scope);matches(plan,state);return{trafficPaused:state.traffic==='paused',originalTrafficRestored:state.traffic===plan.originalTraffic,inFlightDrainProven:false};},
  async change(plan,pause){
   checked(plan);if(typeof pause!=='boolean')throw Error('INVALID_API_TRAFFIC_OPERATION');await assertOwnership(pause?'pause':'restore',plan);
   if(!pause)await assertRestoreSafe(plan);
   const current=await stable(plan.scope);matches(plan,current.state);const desired=pause?'paused':plan.originalTraffic;
   if(![plan.originalTraffic,'paused'].includes(current.state.traffic))throw Error('API_TRAFFIC_STATE_DRIFT');
   if(pause&&current.state.traffic!==desired&&current.version!==plan.originalVersion)throw Error('API_TRAFFIC_CODE_VERSION_CHANGED');
   if(current.state.traffic!==desired){
    // Inherit every other binding by name: never retrieve or re-send secret values.
    // Defaults inherit from latest, so stable() refuses unpublished/split versions.
    const bindings=current.settings.bindings.filter(b=>b.name!==flag).map(b=>({name:b.name,type:'inherit'}));
    if(desired!==null)bindings.push({name:flag,type:'plain_text',text:desired});
    const annotations=Object.fromEntries(Object.entries(current.settings.annotations??{}).filter(([k,v])=>['workers/message','workers/tag'].includes(k)&&typeof v==='string'));
    await assertOwnership(pause?'pause':'restore',plan);if(!pause)await assertRestoreSafe(plan);
    let failure;try{await request('PATCH',path(plan.scope)+'/settings',{bindings,annotations});}catch(error){failure=error;}
    const observed=await stable(plan.scope);matches(plan,observed.state);if(observed.state.traffic!==desired){if(failure)throw failure;throw Error('API_TRAFFIC_UPDATE_INCOMPLETE');}
   }
   await assertOwnership(pause?'pause':'restore',plan);if(!pause)await assertRestoreSafe(plan);return this.inspect(plan);
  },
 };
}
function createCloudflareTrafficTransport(token,{fetcher=fetch}={}){
 if(typeof token!=='string'||token.length<20||token.length>4096||/[\r\n\0]/.test(token))throw Error('INVALID_API_TRAFFIC_CREDENTIAL');
 return async(method,path,settings)=>{
  const match=new RegExp('^accounts/'+account+'/workers/scripts/(videoq-api|videoq-cutover-api-[a-f0-9]{16})/(settings|deployments|versions\\?per_page=1)$').exec(path);
  if(!match||!['GET','PATCH'].includes(method)||method==='PATCH'&&match[2]!=='settings')throw Error('INVALID_API_TRAFFIC_REQUEST');
  let body;if(method==='PATCH'){body=new FormData();body.set('settings',new Blob([JSON.stringify(settings)],{type:'application/json'}));}
  const response=await fetcher('https://api.cloudflare.com/client/v4/'+path,{method,headers:{authorization:'Bearer '+token},body,redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok||!response.body)throw Error('API_TRAFFIC_REQUEST_FAILED');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024)throw Error('API_TRAFFIC_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('API_TRAFFIC_RESPONSE_INVALID');}
  if(data.success!==true)throw Error('API_TRAFFIC_REQUEST_FAILED');return data.result;
 };
}
module.exports={createApiTrafficControl,createCloudflareTrafficTransport,validateApiTrafficPlan:checked};
