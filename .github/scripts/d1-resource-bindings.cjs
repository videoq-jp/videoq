// One fixed same-account replacement. No fallback, rollback, credentials or CLI.
const {createApiTrafficControl,validateApiTrafficPlan}=require('./cutover-api-traffic.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
const sourceDb='e57d0931-18cb-4f00-ae7f-b0068030fb04',targetDb='587bd210-6d9d-4f32-abb7-a490013e65d3';
const names=['DB','SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768'];
const source=[sourceDb,'videoq-scenes-migration-v3-1536','videoq-scenes-migration-v3-768'];
const target=[targetDb,'videoq-prod-scenes-1536','videoq-prod-scenes-768'];
function changed(settings){
 const copy=structuredClone(settings);
 for(let i=0;i<names.length;i++){
  const row=copy.bindings.find(b=>b.name===names[i]);
  if(i===0){if(row?.type!=='d1'||row.id!==source[i]||row.database_id!==source[i]||Object.keys(row).sort().join(',')!=='database_id,id,name,type')throw Error('RESOURCE_BINDING_SOURCE_MISMATCH');row.id=row.database_id=target[i];}
  else{if(row?.type!=='vectorize'||row.index_name!==source[i]||Object.keys(row).sort().join(',')!=='index_name,name,type')throw Error('RESOURCE_BINDING_SOURCE_MISMATCH');row.index_name=target[i];}
 }
 return copy;
}
function bindingHash(settings){return resourceDigest(settings.bindings.filter(b=>b.name!=='MIGRATION_TRAFFIC_STATE').map(b=>b.type.startsWith('secret_')?{name:b.name,type:b.type}:b).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0));}
function validate(plan){
 if(!plan||Object.keys(plan).sort().join(',')!=='pausedVersion,sourcePlan,targetBindingsHash,version'||plan.version!==1||!/^[a-f0-9]{64}$/.test(plan.targetBindingsHash??'')||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(plan.pausedVersion??''))throw Error('RESOURCE_BINDING_PLAN_REQUIRED');
 const original=validateApiTrafficPlan(plan.sourcePlan);if(original.scope.purpose!=='production')throw Error('RESOURCE_BINDING_PRODUCTION_REQUIRED');return plan;
}
function createResourceBindingAdapter({request,plans,assertTransferVerified}){
 if(typeof request!=='function'||typeof plans?.load!=='function'||typeof assertTransferVerified!=='function')throw Error('RESOURCE_BINDING_CONTEXT_REQUIRED');
 const control=createApiTrafficControl(request);
 async function original(plan){validate(plan);if(resourceDigest(await plans.load('pause-api'))!==resourceDigest(plan.sourcePlan))throw Error('RESOURCE_BINDING_ORIGINAL_PLAN_REQUIRED');}
 async function observation(plan){
  await original(plan);const found=await control.observe(plan.sourcePlan.scope);
  if(found.state.traffic!=='paused'||found.state.settingsHash!==plan.sourcePlan.settingsHash)throw Error('RESOURCE_BINDING_PAUSE_REQUIRED');
  if(found.state.bindingsHash===plan.targetBindingsHash)return{state:'applied',found};
  if(found.state.bindingsHash!==plan.sourcePlan.bindingsHash)return{state:'unknown'};
  if(found.version!==plan.pausedVersion)throw Error('RESOURCE_BINDING_VERSION_CHANGED');
  if(bindingHash(changed(found.settings))!==plan.targetBindingsHash)throw Error('RESOURCE_BINDING_PLAN_CHANGED');
  return{state:'not-applied',found};
 }
 return{
  async prepare(){
   const sourcePlan=validateApiTrafficPlan(await plans.load('pause-api'));
   if(sourcePlan.scope.purpose!=='production')throw Error('RESOURCE_BINDING_PRODUCTION_REQUIRED');
   const found=await control.observe(sourcePlan.scope);
   if(found.state.traffic!=='paused'||found.state.settingsHash!==sourcePlan.settingsHash||found.state.bindingsHash!==sourcePlan.bindingsHash)throw Error('RESOURCE_BINDING_PAUSE_REQUIRED');
   return validate({version:1,sourcePlan,pausedVersion:found.version,targetBindingsHash:bindingHash(changed(found.settings))});
  },
  async probe(plan){
   await assertTransferVerified(plan);const observed=await observation(plan);
   return observed.state==='applied'?{state:'applied',receiptSha256:resourceDigest({planSha256:resourceDigest(plan),targetBindingsHash:plan.targetBindingsHash,traffic:'paused'})}:{state:observed.state};
  },
  async apply(plan,{assertOwnership}){
   await assertOwnership();await assertTransferVerified(plan);const observed=await observation(plan);
   if(observed.state==='applied')return;
   if(observed.state!=='not-applied')throw Error('RESOURCE_BINDING_RECONCILIATION_REQUIRED');
   const bindings=observed.found.settings.bindings.map(b=>b.name==='DB'?{name:b.name,type:'d1',id:targetDb}:b.name==='SCENE_VECTORIZE_1536'||b.name==='SCENE_VECTORIZE_768'?{name:b.name,type:'vectorize',index_name:target[names.indexOf(b.name)]}:{name:b.name,type:'inherit'});
   const annotations=Object.fromEntries(Object.entries(observed.found.settings.annotations??{}).filter(([k,v])=>['workers/message','workers/tag'].includes(k)&&typeof v==='string'));
   await assertOwnership();await assertTransferVerified(plan);
   await request('PATCH',`accounts/${plan.sourcePlan.account}/workers/scripts/videoq-api/settings`,{bindings,annotations});
  },
 };
}
module.exports={createResourceBindingAdapter};
