// Fixed data-plane adapter composition. Bridge must enforce claimed executor,
// pending operation and environment checks; no credentials/config discovery.
const {resourceDigest}=require('./d1-resource-journal.cjs');
function createResourceDataAdapters({bridge,plans,token,run,source,directory,assertTargetSafe}){
 if(typeof bridge?.call!=='function'||typeof plans?.load!=='function'||typeof assertTargetSafe!=='function'||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||typeof directory!=='string'||!require('node:path').isAbsolute(directory))throw Error('RESOURCE_DATA_CONTEXT_REQUIRED');
 const call=(action,input)=>bridge.call(action,input,token);
 async function fence(plan){const original=await plans.load('fence-source');if(!original||resourceDigest(plan)!==resourceDigest(original)||plan.owner!==run)throw Error('RESOURCE_DATA_ORIGINAL_FENCE_REQUIRED');return original;}
 async function copied(plan){
  if(!plan||Object.keys(plan).sort().join(',')!=='directory,fencePlan,run,source,sourceSnapshot,version'||plan.version!==1||plan.run!==run||plan.source!==source||plan.directory!==directory)throw Error('RESOURCE_DATA_COPY_PLAN_REQUIRED');
  await fence(plan.fencePlan);
  return{run,source,directory,fencePlan:plan.fencePlan,sourceSnapshot:plan.sourceSnapshot,planSha256:resourceDigest(plan)};
 }
 const receipt=(step,plan,state)=>({state:'applied',receiptSha256:resourceDigest({step,planSha256:resourceDigest(plan),state})});
 function fenceAdapter(target){return{
  async prepare(){return target?fence(await plans.load('fence-source')):call('prepare-fence',{run});},
  async probe(plan){
   await fence(plan);if(target)await assertTargetSafe(plan);
   const state=await call(target?'inspect-target-fence':'inspect-source-fence',{plan});
   if(!Array.isArray(state.installed)||!Number.isSafeInteger(state.total)||state.total<=0||state.installed.length>state.total)throw Error('RESOURCE_DATA_FENCE_OBSERVATION_INVALID');
   return(target?state.installed.length===0:state.installed.length===state.total)?receipt(target?'unfence-target':'fence-source',plan,state):{state:'not-applied'};
  },
  async apply(plan,{assertOwnership}){await fence(plan);await assertOwnership();if(target)await assertTargetSafe(plan);await call(target?'remove-target-fence':'install-source-fence',{plan});},
 };}
 return{
  'fence-source':fenceAdapter(false),
  'copy-database':{
   async prepare(){const fencePlan=await fence(await plans.load('fence-source')),sourceSnapshot=await call('prepare-copy',{plan:fencePlan});return{version:1,run,source,directory,fencePlan,sourceSnapshot};},
   async probe(plan){const result=await call('inspect-copy',await copied(plan));if(result.databaseVerified===true&&/^[a-f0-9]{64}$/.test(result.receiptSha256??''))return{state:'applied',receiptSha256:result.receiptSha256};if(result.databaseVerified!==false||typeof result.reconciliationRequired!=='boolean')throw Error('RESOURCE_DATA_COPY_OBSERVATION_INVALID');return{state:result.reconciliationRequired?'unknown':'not-applied'};},
   async apply(plan,{assertOwnership}){await assertOwnership();await call('advance-copy',await copied(plan));return{pending:true};},
  },
  'unfence-target':fenceAdapter(true),
 };
}
module.exports={createResourceDataAdapters};
