// Candidate synchronization uses private Python artifacts, not large vector
// payloads in the Node plan or DynamoDB journal. No model or outbox mutation.
const {resourceDigest}=require('./d1-resource-journal.cjs');
function createResourceVectorAdapter({bridge,plans,token,run,source,directory,assertCopyVerified}){
 if(typeof bridge?.call!=='function'||typeof plans?.load!=='function'||typeof assertCopyVerified!=='function'||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||typeof directory!=='string'||!require('node:path').isAbsolute(directory))throw Error('RESOURCE_VECTOR_ADAPTER_CONTEXT_REQUIRED');
 const call=(action,input)=>bridge.call(action,input,token);
 async function fence(){const plan=await plans.load('fence-source');if(!plan||plan.owner!==run)throw Error('RESOURCE_VECTOR_ORIGINAL_FENCE_REQUIRED');return plan;}
 async function config(plan){
  await assertCopyVerified();
  if(!plan||Object.keys(plan).sort().join(',')!=='batches,deferredPending,directory,fencePlan,manifestSha256,run,source,vectors,version'||plan.version!==1||plan.run!==run||plan.source!==source||plan.directory!==directory||!/^[a-f0-9]{64}$/.test(plan.manifestSha256??'')||['batches','vectors','deferredPending'].some(key=>!Number.isSafeInteger(plan[key])||plan[key]<0)||resourceDigest(await fence())!==resourceDigest(plan.fencePlan))throw Error('RESOURCE_VECTOR_ADAPTER_PLAN_REQUIRED');
  return{run,source,directory,fencePlan:plan.fencePlan,manifestSha256:plan.manifestSha256};
 }
 return{
  async prepare(){await assertCopyVerified();const fencePlan=await fence(),result=await call('prepare-vectors',{run,source,directory,fencePlan});const plan={version:1,run,source,directory,fencePlan,...result};await config(plan);return plan;},
  async probe(plan){const state=await call('inspect-vectors',await config(plan));if(state.verified===true&&/^[a-f0-9]{64}$/.test(state.receiptSha256??''))return{state:'applied',receiptSha256:state.receiptSha256};if(state.verified!==false||typeof state.reconciliationRequired!=='boolean')throw Error('RESOURCE_VECTOR_ADAPTER_OBSERVATION_INVALID');return{state:state.reconciliationRequired?'unknown':'not-applied'};},
  async apply(plan,{assertOwnership}){await assertOwnership();await call('advance-vectors',await config(plan));return{pending:true};},
 };
}
module.exports={createResourceVectorAdapter};
