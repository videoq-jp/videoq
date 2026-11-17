// Trusted composition, disabled by default. The operator must supply actual
// reviewed-source/exclusive-executor checks. Mutating workers share a kernel
// mutex; abort mode probes it before source recovery. No credentials
// are discovered here and no provider is contacted during construction.
const {createResourceJournal,RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const {createResourceCoordinator}=require('./d1-resource-coordinator.cjs');
const {createResourceBridge}=require('./d1-resource-bridge.cjs');
const {createResourceDataAdapters}=require('./d1-resource-data.cjs');
const {createResourceVectorAdapter}=require('./d1-resource-vectors.cjs');
const {createResourceBindingAdapter}=require('./d1-resource-bindings.cjs');
const {createResourceApiAdapters}=require('./d1-resource-api.cjs');
const {createResourceConsumerAdapters}=require('./d1-resource-consumers.cjs');
const {createResourceDeploymentAdapters}=require('./d1-resource-deployments.cjs');
const {createResourceSmokeProof}=require('./d1-resource-smoke-proof.cjs');
const {createResourceSmokeLauncher}=require('./d1-resource-smoke-launcher.cjs');
const {createResourceE2eAdapter}=require('./d1-resource-e2e.cjs');
const {createResourceCurrentState}=require('./d1-resource-current-state.cjs');
const {createResourceCompletion}=require('./d1-resource-completion.cjs');
const {createResourceAbortSourceSafety}=require('./d1-resource-abort-safety.cjs');
const {createResourceAbortRecovery}=require('./d1-resource-abort-recovery.cjs');
const {createResourceBuildGuard}=require('./d1-resource-builds.cjs');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
const {createConsumerControl}=require('./cutover-sqs-consumers.cjs');
const {createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
function createResourceRuntime({aws,cloudflare,lambda,github,plans,run,source,executorToken,definitionSha256,directory,token,assertRuntime,assertRecoveryLease,bridgeFactory=createResourceBridge,python='python3',enabled=false}){
 if(typeof enabled!=='boolean'||!/^[a-f0-9]{64}$/.test(executorToken??'')||enabled&&(typeof token!=='string'||token.length<20||token.length>4096||/[\r\n\0]/.test(token)))throw Error('RESOURCE_RUNTIME_PRIVATE_CONTEXT_REQUIRED');
 if([aws,cloudflare,lambda,github,assertRuntime,assertRecoveryLease,bridgeFactory].some(v=>typeof v!=='function')||typeof plans?.load!=='function'||typeof plans?.save!=='function'||typeof directory!=='string'||!require('node:path').isAbsolute(directory))throw Error('RESOURCE_RUNTIME_CONTEXT_REQUIRED');
 const journal=createResourceJournal({aws,run,source,executorToken,expectedDefinitionHash:definitionSha256,enabled});
 const executorSha256=resourceDigest({executorToken});
 const proof=createResourceSmokeProof({aws,assertExecutor:()=>journal.assertExecutor(),run,source,executorSha256,definitionSha256});
 const builds=createResourceBuildGuard({aws,journal,plans,proof});
 const apiControl=createApiTrafficControl(cloudflare);
 const equal=(a,b)=>resourceDigest(a)===resourceDigest(b);
 function checkEnabled(){if(!enabled)throw Error('RESOURCE_RUNTIME_DISABLED');}
 async function saved(step,verified=false){
  const state=await journal.inspect(),entry=state.steps.find(v=>v.step===step),plan=await plans.load(step);
  if(!entry||!plan||entry.planSha256!==resourceDigest(plan)||verified&&entry.state!=='verified')throw Error('RESOURCE_RUNTIME_SAVED_PROOF_REQUIRED');return{entry,plan};
 }
 async function originalFence(){const {plan}=await saved('fence-source');if(plan.owner!==run)throw Error('RESOURCE_RUNTIME_ORIGINAL_FENCE_REQUIRED');return plan;}
 async function normalOperation(action,input){
  const state=await journal.inspect(),step=state.nextStep;
  const permitted=(name,pending=false)=>{if(step!==name||pending&&state.steps.at(-1)?.state!=='intent')throw Error('RESOURCE_RUNTIME_OPERATION_REQUIRED');};
  if(action==='prepare-fence'){permitted('fence-source');if(!equal(input,{run}))throw Error('RESOURCE_RUNTIME_OPERATION_INPUT_REQUIRED');return;}
  const fence=await originalFence();
  if(['inspect-source-fence','inspect-target-fence','install-source-fence','remove-target-fence','prepare-copy'].includes(action)){
   if(!equal(input,{plan:fence}))throw Error('RESOURCE_RUNTIME_OPERATION_INPUT_REQUIRED');
   if(action==='install-source-fence')permitted('fence-source',true);
   if(action==='remove-target-fence')permitted('unfence-target',true);
   if(action==='prepare-copy')permitted('copy-database');return;
  }
  if(['inspect-copy','advance-copy'].includes(action)){
   const {plan}=await saved('copy-database');
   if(!equal(input,{run,source,directory,fencePlan:plan.fencePlan,sourceSnapshot:plan.sourceSnapshot,planSha256:resourceDigest(plan)}))throw Error('RESOURCE_RUNTIME_OPERATION_INPUT_REQUIRED');
   if(action==='advance-copy')permitted('copy-database',true);return;
  }
  if(action==='prepare-vectors'){
   permitted('synchronize-vectors');if(!equal(input,{run,source,directory,fencePlan:fence}))throw Error('RESOURCE_RUNTIME_OPERATION_INPUT_REQUIRED');return;
  }
  if(['inspect-vectors','advance-vectors'].includes(action)){
   const {plan}=await saved('synchronize-vectors');
   if(!equal(input,{run,source,directory,fencePlan:fence,manifestSha256:plan.manifestSha256}))throw Error('RESOURCE_RUNTIME_OPERATION_INPUT_REQUIRED');
   if(action==='advance-vectors')permitted('synchronize-vectors',true);return;
  }
  throw Error('RESOURCE_RUNTIME_OPERATION_REQUIRED');
 }
 let data,vector;
 const bridge=bridgeFactory({python,enabled,directory,assertExecutor:()=>journal.assertExecutor(),assertOperation:normalOperation,
  assertTargetSafe:()=>targetSafe(),
  assertImportSafe:async()=>{await journal.assertPending({step:'copy-database',planSha256:resourceDigest((await saved('copy-database')).plan)});await closedAdmission();await api(false,'paused');await sourceFenced();},
  assertVectorSafe:async()=>{await journal.assertPending({step:'synchronize-vectors',planSha256:resourceDigest((await saved('synchronize-vectors')).plan)});await closedAdmission();await api(false,'paused');await sourceFenced();},
 });
 async function fenceState(target=false){const plan=await originalFence();const value=await bridge.call(target?'inspect-target-fence':'inspect-source-fence',{plan},token);const expected=Object.keys(plan.fenceTriggers??{}).sort();if(!expected.length||value.total!==expected.length||!Array.isArray(value.installed)||new Set(value.installed).size!==value.installed.length||value.installed.some(name=>!expected.includes(name)))throw Error('RESOURCE_RUNTIME_FENCE_OBSERVATION_REQUIRED');return value;}
 async function sourceFenced(){const {entry}=await saved('fence-source',true),value=await fenceState();if(value.installed.length!==value.total||!entry.receiptSha256)throw Error('RESOURCE_RUNTIME_SOURCE_FENCE_REQUIRED');}
 async function targetUnfenced(){const value=await fenceState(true);if(value.installed.length)throw Error('RESOURCE_RUNTIME_TARGET_STILL_FENCED');}
 function fixedApi(value,target){
  const targets=target?['587bd210-6d9d-4f32-abb7-a490013e65d3','videoq-prod-scenes-1536','videoq-prod-scenes-768']:['e57d0931-18cb-4f00-ae7f-b0068030fb04','videoq-scenes-migration-v3-1536','videoq-scenes-migration-v3-768'];
  for(const [i,name] of ['DB','SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768'].entries()){
   const row=value.settings.bindings.find(v=>v.name===name);if(row?.type!==(i?'vectorize':'d1')||row[i?'index_name':'id']!==targets[i]||!i&&row.database_id!==undefined&&row.database_id!==targets[i])throw Error('RESOURCE_RUNTIME_API_BINDINGS_REQUIRED');
  }
 }
 async function api(target,traffic){
  const {plan:paused}=await saved('pause-api',true),value=await apiControl.observe({purpose:'production'});
  const wanted=target?(await saved('promote-bindings')).plan.targetBindingsHash:paused.bindingsHash;
  fixedApi(value,target);
  const allowed=traffic==='either'?['paused',paused.originalTraffic]:[traffic==='original'?paused.originalTraffic:'paused'];
  if(value.state.bindingsHash!==wanted||value.state.settingsHash!==paused.settingsHash||!allowed.includes(value.state.traffic))throw Error('RESOURCE_RUNTIME_API_STATE_REQUIRED');return value;
 }
 async function frozen(){const {plan}=await saved('freeze-deployments',true),value=await createDeploymentFreeze(github).inspect(plan);if(!value.admissionFrozen||!value.githubRunsDrained)throw Error('RESOURCE_RUNTIME_DEPLOYMENT_DRAIN_REQUIRED');}
 async function closedAdmission(){await frozen();const {plan}=await saved('pause-consumers',true);if(!(await createConsumerControl(lambda).inspect(plan)).admissionPaused)throw Error('RESOURCE_RUNTIME_CONSUMERS_NOT_PAUSED');}
 async function copied(){const {plan,entry}=await saved('copy-database',true),value=await data['copy-database'].probe(plan);if(value.state!=='applied'||value.receiptSha256!==entry.receiptSha256)throw Error('RESOURCE_RUNTIME_DATABASE_PROOF_REQUIRED');}
 async function transferred(){await copied();const {plan,entry}=await saved('synchronize-vectors',true),value=await vector.probe(plan);if(value.state!=='applied'||value.receiptSha256!==entry.receiptSha256)throw Error('RESOURCE_RUNTIME_VECTOR_PROOF_REQUIRED');}
 async function durableTransfer(){await saved('copy-database',true);await saved('synchronize-vectors',true);}
 async function targetSafe(){await durableTransfer();await sourceFenced();await closedAdmission();await api(true,'paused');}
 async function resumedBackend(){await durableTransfer();await saved('promote-bindings',true);await saved('unfence-target',true);await sourceFenced();await targetUnfenced();return api(true,'either');}
 data=createResourceDataAdapters({bridge,plans,token,run,source,directory,assertTargetSafe:targetSafe});
 vector=createResourceVectorAdapter({bridge,plans,token,run,source,directory,assertCopyVerified:copied});
 const binding=createResourceBindingAdapter({request:cloudflare,plans,assertTransferVerified:async()=>{await sourceFenced();await closedAdmission();await transferred();}});
 const apiAdapters=createResourceApiAdapters({request:cloudflare,plans,assertOwnership:()=>journal.assertExecutor(),verifiedBackendHandoff:async()=>{await resumedBackend();return{bindingsHash:(await saved('promote-bindings',true)).plan.targetBindingsHash};}});
 const consumerAdapters=createResourceConsumerAdapters({aws:lambda,plans,assertBackendSafe:async({resume})=>{if(resume){await resumedBackend();await api(true,'original');}else await api(false,'paused');}});
 const launcher=createResourceSmokeLauncher({aws,journal,proof,run,source,executorSha256,enabled});
 const e2e=createResourceE2eAdapter({journal,plans,cloudflare,proof,launcher});
 const adapters={...createResourceDeploymentAdapters({request:github,plans}),...apiAdapters,...consumerAdapters,...data,'synchronize-vectors':vector,'promote-bindings':binding,'verify-e2e':e2e};
 async function environment({step,stage}){
  await journal.assertExecutor();await assertRuntime({mode:'normal',step,stage});await builds({allowOwnedSmoke:step==='verify-e2e'});
  const index=RESOURCE_STEPS.indexOf(step);if(index<0)throw Error('RESOURCE_RUNTIME_STEP_REQUIRED');
  if(index<=1){
   const value=await apiControl.observe({purpose:'production'});fixedApi(value,false);
   if(![null,'running'].includes(value.state.traffic)){
    const record=(await journal.inspect()).steps.find(v=>v.step==='pause-api'),plan=await plans.load('pause-api');
    if(index!==1||!record||!plan||record.planSha256!==resourceDigest(plan)||value.state.traffic!=='paused'||value.state.bindingsHash!==plan.bindingsHash||value.state.settingsHash!==plan.settingsHash)throw Error('RESOURCE_RUNTIME_UNOWNED_API_PAUSE');
   }
  }
  if(index>0&&index<11)await frozen();
  if(index===2)await api(false,'paused');
  if(index>=3&&index<=7)await closedAdmission();
  if(index===3||index===4||index===5)await api(false,'paused');
  if(index>=4)await sourceFenced();
  if(index===7)await api(true,'paused');
  if(index>=8){await resumedBackend();await api(true,index===8?'either':'original');}
  if(index>=10){const {plan}=await saved('resume-consumers',true);if(!(await createConsumerControl(lambda).inspect(plan)).originalAdmissionRestored)throw Error('RESOURCE_RUNTIME_CONSUMERS_NOT_RESTORED');}
 }
 const coordinator=createResourceCoordinator({journal,adapters,plans,assertEnvironment:environment,enabled});
 const verifyCurrentState=createResourceCurrentState({journal,plans,cloudflare,lambda,github,sourceFence:()=>fenceState(),targetFence:()=>fenceState(true),smokeProof:proof,readSmokeBuild:plan=>launcher.readBuild(plan)});
 const completion=createResourceCompletion({aws,journal,run,source,executorToken,verifyCurrentState:async state=>{await assertRuntime({mode:'normal',step:'completion',stage:'before-proof'});await builds();return verifyCurrentState(state);},enabled});
 let recoveryBarrier=false;
 const abortSafety=createResourceAbortSourceSafety({journal,plans,cloudflare,lambda,github,assertRecoveryIsolation:async()=>{
  if(!recoveryBarrier)throw Error('RESOURCE_RUNTIME_WORKER_BARRIER_REQUIRED');
  await journal.assertAbortExecutor();await assertRecoveryLease();
 }});
 async function abortOperation(action,input){
  const state=await journal.assertAbortExecutor(),entry=state.steps.find(v=>v.step==='fence-source');
  if(action==='worker-lock-check'&&equal(input,{}))return;
  if(action==='prepare-fence'&&!entry&&equal(input,{run}))return;
  if(!['inspect-source-fence','remove-source-fence'].includes(action)||!entry)throw Error('RESOURCE_RUNTIME_ABORT_OPERATION_REQUIRED');
  const plan=await plans.load('fence-source');if(!plan||entry.planSha256!==resourceDigest(plan)||!equal(input,{plan}))throw Error('RESOURCE_RUNTIME_ABORT_PLAN_REQUIRED');
 }
 const abortBridge=bridgeFactory({python,enabled,directory,assertExecutor:()=>journal.assertAbortExecutor(),assertOperation:abortOperation,assertTargetSafe:async()=>{throw Error('RESOURCE_RUNTIME_ABORT_TARGET_REFUSED');},assertSourceSafe:abortSafety});
 const abort=createResourceAbortRecovery({aws,journal:{requestAbort:async()=>{await assertRuntime({mode:'abort',step:'recovery',stage:'before-progress'});await journal.requestAbort();await builds({abort:true});recoveryBarrier=false;const barrier=await abortBridge.call('worker-lock-check',{},null);if(barrier.owned!==true||barrier.exclusiveWorker!==true)throw Error('RESOURCE_RUNTIME_WORKER_BARRIER_REQUIRED');recoveryBarrier=true;},assertAbortExecutor:()=>journal.assertAbortExecutor()},plans,cloudflare,lambda,github,run,source,executorToken,enabled,
  sourceFence:{inspect:plan=>abortBridge.call('inspect-source-fence',{plan},token),remove:plan=>abortBridge.call('remove-source-fence',{plan},token),assertUnfenced:async plan=>{
   if(!plan){const prepared=await abortBridge.call('prepare-fence',{run},token);if(prepared.owner!==run||!prepared.original)throw Error('RESOURCE_RUNTIME_ABORT_SCHEMA_REQUIRED');return resourceDigest(prepared.original);}
   const value=await abortBridge.call('inspect-source-fence',{plan},token);if(!Array.isArray(value.installed)||value.installed.length||!/^[a-f0-9]{64}$/.test(value.schemaSha256??''))throw Error('RESOURCE_RUNTIME_ABORT_SOURCE_STILL_FENCED');return value.schemaSha256;
  }},
 });
 return{
  async claim(){checkEnabled();await assertRuntime({mode:'normal',step:'claim',stage:'before-claim'});return journal.claimExecutor();},
  async advance(){checkEnabled();return coordinator.runNext();},
  async complete(){checkEnabled();return completion.request();},
  async abort(){checkEnabled();return abort.advance();},
 };
}
module.exports={createResourceRuntime};
