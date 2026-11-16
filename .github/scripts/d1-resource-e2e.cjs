// E2E step wiring; real API observation is mandatory. It neither handles app
// credentials nor starts anything except through the registered owned launcher.
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
const TARGET={account:'12daec56fdba43f677f2766ee26a5a39',database:'587bd210-6d9d-4f32-abb7-a490013e65d3',large:'videoq-prod-scenes-1536',small:'videoq-prod-scenes-768'};
function createResourceE2eAdapter({journal,plans,cloudflare,proof,launcher,now=()=>new Date().toISOString()}){
 if(typeof journal?.assertExecutor!=='function'||typeof journal?.inspect!=='function'||typeof plans?.load!=='function'||typeof cloudflare!=='function'||typeof proof?.prepare!=='function'||['observe','advance'].some(k=>typeof launcher?.[k]!=='function')||typeof now!=='function')throw Error('RESOURCE_E2E_CONTEXT_REQUIRED');
 const control=createApiTrafficControl(cloudflare);
 async function target(plan){
  await journal.assertExecutor();const state=await journal.inspect(),index=RESOURCE_STEPS.indexOf('verify-e2e');
  if(state.nextStep!=='verify-e2e'||state.steps.length<index||state.steps.slice(0,index).some((v,i)=>v.step!==RESOURCE_STEPS[i]||v.state!=='verified'))throw Error('RESOURCE_E2E_PRECEDING_STEPS_REQUIRED');
  const [resumed,promotion]=await Promise.all(['resume-api','promote-bindings'].map(k=>plans.load(k)));
  if(!resumed||!promotion||[['resume-api',resumed],['promote-bindings',promotion]].some(([name,value])=>resourceDigest(value)!==state.steps.find(v=>v.step===name)?.planSha256)||resumed.scope?.purpose!=='production'||resumed.account!==TARGET.account||resumed.worker!=='videoq-api'||![null,'running'].includes(resumed.originalTraffic)||resumed.bindingsHash!==promotion.targetBindingsHash)throw Error('RESOURCE_E2E_RESUMED_PLAN_REQUIRED');
  const api=await control.observe({purpose:'production'});
  if(api.state.traffic!==resumed.originalTraffic||api.state.settingsHash!==resumed.settingsHash||api.state.bindingsHash!==resumed.bindingsHash)throw Error('RESOURCE_E2E_API_NOT_RESUMED');
  for(const [name,type,key,expected] of [['DB','d1','id',TARGET.database],['SCENE_VECTORIZE_1536','vectorize','index_name',TARGET.large],['SCENE_VECTORIZE_768','vectorize','index_name',TARGET.small]]){
   const row=api.settings.bindings.find(v=>v.name===name);if(row?.type!==type||row[key]!==expected||name==='DB'&&row.database_id!==undefined&&row.database_id!==expected)throw Error('RESOURCE_E2E_TARGET_BINDINGS_REQUIRED');
  }
  if(plan&&(Object.keys(plan).sort().join(',')!=='apiBindingsSha256,apiVersion,nativePlan,version'||plan.version!==1||plan.apiVersion!==api.version||plan.apiBindingsSha256!==api.state.bindingsHash))throw Error('RESOURCE_E2E_API_CHANGED');
  await journal.assertExecutor();return api;
 }
 return{
  async prepare(){
   const api=await target(),notBefore=now();if(typeof notBefore!=='string'||!Number.isFinite(Date.parse(notBefore)))throw Error('RESOURCE_E2E_TIME_REQUIRED');
   const plan={version:1,apiVersion:api.version,apiBindingsSha256:api.state.bindingsHash,nativePlan:await proof.prepare(notBefore)};
   await target(plan);return plan;
  },
  async probe(plan){
   await target(plan);const status=await launcher.observe(plan);await target(plan);
   if(status.state==='succeeded'){
    if(!status.proof||resourceDigest(status.proof.receipt)!==status.proof.receiptSha256)throw Error('RESOURCE_E2E_NATIVE_RECEIPT_REQUIRED');
    return{state:'applied',receiptSha256:resourceDigest({nativeReceiptSha256:status.proof.receiptSha256,apiVersion:plan.apiVersion,apiBindingsSha256:plan.apiBindingsSha256})};
   }
   if(['not-started','unregistered','pending'].includes(status.state))return{state:'not-applied'};
   if(status.state==='failed')return{state:'unknown'};
   throw Error('RESOURCE_E2E_NATIVE_STATUS_REQUIRED');
  },
  async apply(plan,{assertOwnership}){await assertOwnership();await target(plan);await launcher.advance(plan);await assertOwnership();await target(plan);return{pending:true};},
 };
}
module.exports={createResourceE2eAdapter};
