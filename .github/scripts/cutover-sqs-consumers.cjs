// Admission control only: disabled SQS mappings do not prove running Lambdas,
// direct invocations or external effects are drained. No concurrency-zero change.
const {randomUUID}=require('node:crypto');
const PREFIX='arn:aws:lambda:ap-northeast-1:257240362763:function:';
const QUEUE='arn:aws:sqs:ap-northeast-1:257240362763:';
const groups=['media','search','account'];
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function targets(scope) {
  if(scope?.purpose==='production'&&Object.keys(scope).length===1) return groups.map(group=>group==='media'?'videoq-worker-prod':'videoq-worker-'+group+'-prod');
  if(scope?.purpose==='isolated-rehearsal'&&Object.keys(scope).length===2&&/^[a-f0-9]{16}$/.test(scope.nonce??'')) return groups.map(group=>'videoq-cutover-'+scope.nonce+'-'+group);
  throw Error('INVALID_CONSUMER_SCOPE');
}
function checked(plan) {
  if(plan?.version!==1||!uuid.test(plan.operationId??'')||!Array.isArray(plan.consumers)||plan.consumers.length!==3) throw Error('INVALID_CONSUMER_PLAN');
  const names=targets(plan.scope);
  for(let i=0;i<3;i++){
    const item=plan.consumers[i];
    if(item.functionName!==names[i]||item.functionArn!==PREFIX+names[i]||item.queueArn!==QUEUE+names[i]||!uuid.test(item.mappingUuid??'')||typeof item.wasEnabled!=='boolean') throw Error('INVALID_CONSUMER_PLAN');
  }
  if(new Set(plan.consumers.map(c=>c.mappingUuid)).size!==3) throw Error('INVALID_CONSUMER_PLAN');
  return plan;
}
function createConsumerControl(aws,{assertOwnership=async()=>{throw Error('CONSUMER_OPERATION_OWNERSHIP_REQUIRED');}}={}) {
  async function mapping(name) {
    const result=await aws('ListEventSourceMappings',{FunctionName:name,MaxItems:100});
    if(result.NextMarker||!Array.isArray(result.EventSourceMappings)||result.EventSourceMappings.length!==1) throw Error('UNEXPECTED_CONSUMER_MAPPING_INVENTORY');
    const row=result.EventSourceMappings[0];
    if(row.FunctionArn!==PREFIX+name||row.EventSourceArn!==QUEUE+name||!uuid.test(row.UUID??'')) throw Error('UNEXPECTED_CONSUMER_MAPPING_TARGET');
    return row;
  }
  async function observed(raw) {
    const plan=checked(raw),states=[];
    for(const item of plan.consumers){
      const row=await mapping(item.functionName);
      if(row.UUID!==item.mappingUuid) throw Error('CONSUMER_MAPPING_REPLACED');
      states.push({item,state:row.State});
    }
    return states;
  }
  return {
    async prepare(scope) {
      const consumers=[];
      for(const name of targets(scope)){
        const row=await mapping(name);
        if(!['Enabled','Disabled'].includes(row.State)) throw Error('CONSUMER_MAPPING_TRANSITION_IN_PROGRESS');
        consumers.push({functionName:name,functionArn:row.FunctionArn,queueArn:row.EventSourceArn,mappingUuid:row.UUID,wasEnabled:row.State==='Enabled'});
      }
      return checked({version:1,operationId:randomUUID(),scope,consumers});
    },
    async inspect(plan) {
      const states=await observed(plan);
      return {admissionPaused:states.every(row=>row.state==='Disabled'),originalAdmissionRestored:states.every(row=>row.state===(row.item.wasEnabled?'Enabled':'Disabled')),states:states.map(row=>({functionName:row.item.functionName,state:row.state}))};
    },
    async pause(plan) {
      await assertOwnership('pause',checked(plan));
      const states=await observed(plan);
      if(states.some(row=>!['Enabled','Disabling','Disabled'].includes(row.state)||!row.item.wasEnabled&&row.state!=='Disabled')) throw Error('CONSUMER_MAPPING_STATE_DRIFT');
      for(const {item,state} of states) if(state==='Enabled') {
        await assertOwnership('pause',plan);
        await aws('UpdateEventSourceMapping',{UUID:item.mappingUuid,Enabled:false});
      }
      await assertOwnership('pause',plan);
      return this.inspect(plan);
    },
    async resume(plan) {
      await assertOwnership('resume',checked(plan));
      const states=await observed(plan);
      if(states.some(row=>!['Enabled','Enabling','Disabled'].includes(row.state)||!row.item.wasEnabled&&row.state!=='Disabled')) throw Error('CONSUMER_MAPPING_STATE_DRIFT');
      for(const {item,state} of states) if(item.wasEnabled&&state==='Disabled') {
        await assertOwnership('resume',plan);
        await aws('UpdateEventSourceMapping',{UUID:item.mappingUuid,Enabled:true});
      }
      await assertOwnership('resume',plan);
      return this.inspect(plan);
    },
  };
}
module.exports={createConsumerControl};
