// Trusted coordinator primitive only: no CLI, credential loading or data-plane
// mutation. Plans stay private; only their digests enter the ownership journal.
const {createHash,randomUUID}=require('node:crypto');
const TABLE='videoq-db-maintenance-prod';
const MACHINE='arn:aws:states:ap-northeast-1:257240362763:stateMachine:videoq-db-maintenance-prod';
const KIND='d1-resource-hold';
const STEPS=Object.freeze(['freeze-deployments','pause-api','pause-consumers','fence-source','copy-database','synchronize-vectors','promote-bindings','unfence-target','resume-api','resume-consumers','verify-e2e','restore-deployments']);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function records(row){
 if(!row.resource_steps){if(row.resource_steps_sha256)throw Error('RESOURCE_JOURNAL_CORRUPT');return[];}
 if(typeof row.resource_steps.S!=='string'||row.resource_steps.S.length>32768||!hex(row.resource_steps_sha256?.S))throw Error('RESOURCE_JOURNAL_CORRUPT');
 let steps;try{steps=JSON.parse(row.resource_steps.S);}catch{throw Error('RESOURCE_JOURNAL_CORRUPT');}
 if(digest(steps)!==row.resource_steps_sha256.S)throw Error('RESOURCE_JOURNAL_CORRUPT');
 if(!Array.isArray(steps)||steps.length>STEPS.length)throw Error('RESOURCE_JOURNAL_CORRUPT');
 steps.forEach((r,i)=>{
  const keys=r?.state==='verified'?['operationId','planSha256','receiptSha256','state','step']:['operationId','planSha256','state','step'];
  if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!==keys.sort().join(',')||r.step!==STEPS[i]||!['intent','verified'].includes(r.state)||!hex(r.planSha256)||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(r.operationId??'')||(r.state==='verified'&&!hex(r.receiptSha256))||(i<steps.length-1&&r.state!=='verified'))throw Error('RESOURCE_JOURNAL_CORRUPT');
 });
 return steps;
}
function argumentsFor(value,keys){if(!value||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw Error('INVALID_RESOURCE_JOURNAL_ARGUMENTS');}
function createResourceJournal({aws,run,source,expectedDefinitionHash,enabled=false}){
 if(!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||!hex(expectedDefinitionHash)||typeof aws!=='function')throw Error('INVALID_RESOURCE_JOURNAL_CONTEXT');
 const arn=MACHINE.replace(':stateMachine:',':execution:')+':db-'+run,key={pk:{S:'run#'+run}};
 const read=async name=>(await aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:name}},ConsistentRead:true})).Item;
 async function owned(){
  if(!enabled)throw Error('RESOURCE_JOURNAL_DISABLED');
  const [row,owner,state,bound]=await Promise.all([read('run#'+run),read('maintenance'),aws('sfn','DescribeExecution',{executionArn:arn}),aws('sfn','DescribeStateMachineForExecution',{executionArn:arn})]);
  let spec;try{spec=JSON.parse(bound.definition);}catch{throw Error('RESOURCE_HOLD_DEFINITION_REQUIRED');}
  if(state.status!=='RUNNING'||digest(spec)!==expectedDefinitionHash)throw Error('RESOURCE_HOLD_EXECUTION_REQUIRED');
  const revision=row?.resource_revision?.N;
  if(row?.kind?.S!==KIND||row.execution_arn?.S!==arn||row.source_sha?.S!==source||row.resource_phase?.S!=='holding'||row.release_requested?.BOOL!==false||owner?.kind?.S!==KIND||owner.execution_arn?.S!==arn||!/^(0|[1-9][0-9]*)$/.test(revision??'')||!Number.isSafeInteger(Number(revision))||Number(revision)>=Number.MAX_SAFE_INTEGER)throw Error('RESOURCE_JOURNAL_OWNERSHIP_REQUIRED');
  records(row);return row;
 }
 async function save(before,steps){
  const text=JSON.stringify(steps),sha=digest(steps),next={N:String(Number(before.resource_revision.N)+1)};
  const old=before.resource_steps? 'resource_steps = :oldSteps AND resource_steps_sha256 = :oldSha':'attribute_not_exists(resource_steps) AND attribute_not_exists(resource_steps_sha256)';
  const values={':execution':{S:arn},':kind':{S:KIND},':source':{S:source},':holding':{S:'holding'},':false':{BOOL:false},':previous':before.resource_revision,':next':next,':steps':{S:text},':sha':{S:sha},...(before.resource_steps?{':oldSteps':before.resource_steps,':oldSha':before.resource_steps_sha256}:{})};
  const input={TransactItems:[{Update:{TableName:TABLE,Key:key,UpdateExpression:'SET resource_steps = :steps, resource_steps_sha256 = :sha, resource_revision = :next',ConditionExpression:'execution_arn = :execution AND #kind = :kind AND source_sha = :source AND resource_phase = :holding AND release_requested = :false AND resource_revision = :previous AND '+old,ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:values}},{ConditionCheck:{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:KIND}}}}]};
  const saved=async()=>{const found=await read('run#'+run);return found?.resource_revision?.N===next.N&&found.resource_steps?.S===text&&found.resource_steps_sha256?.S===sha;};
  await owned();
  try{await aws('ddb','TransactWriteItems',input);}catch(error){if(!await saved())throw error;}
  if(!await saved())throw Error('RESOURCE_JOURNAL_WRITE_NOT_DURABLE');
  await owned();
 }
 function checkStep(value,receipt=false){
  argumentsFor(value,receipt?['step','planSha256','receiptSha256']:['step','planSha256']);
  if(!STEPS.includes(value.step)||!hex(value.planSha256)||(receipt&&!hex(value.receiptSha256)))throw Error('INVALID_RESOURCE_STEP');
 }
 return{
  async inspect(){const row=await owned(),steps=records(row);return{run,source,revision:Number(row.resource_revision.N),steps,nextStep:steps.at(-1)?.state==='intent'?steps.at(-1).step:STEPS[steps.length]??null,promotionIntentRecorded:steps.some(r=>r.step==='promote-bindings')};},
  async begin(value){
   checkStep(value);const row=await owned(),steps=records(row),index=STEPS.indexOf(value.step),existing=steps[index];
   if(existing){if(existing.planSha256!==value.planSha256)throw Error('RESOURCE_STEP_PLAN_CHANGED');return existing;}
   if(index!==steps.length||steps.some(r=>r.state!=='verified'))throw Error('RESOURCE_STEP_ORDER_REQUIRED');
   const record={step:value.step,operationId:randomUUID(),planSha256:value.planSha256,state:'intent'};await save(row,[...steps,record]);return record;
  },
  async assertPending(value){checkStep(value);const steps=records(await owned()),last=steps.at(-1);if(last?.step!==value.step||last.state!=='intent'||last.planSha256!==value.planSha256)throw Error('RESOURCE_STEP_NOT_PENDING');return last;},
  async verify(value){
   checkStep(value,true);const row=await owned(),steps=records(row),index=STEPS.indexOf(value.step),record=steps[index];
   if(record?.state==='verified'){if(record.planSha256!==value.planSha256||record.receiptSha256!==value.receiptSha256)throw Error('RESOURCE_STEP_PROOF_CHANGED');return record;}
   if(index!==steps.length-1||record?.state!=='intent'||record.planSha256!==value.planSha256)throw Error('RESOURCE_STEP_NOT_PENDING');
   const verified={...record,state:'verified',receiptSha256:value.receiptSha256};await save(row,[...steps.slice(0,-1),verified]);return verified;
  },
  async assertPrePromotionAbort(){const steps=records(await owned());if(steps.some(r=>r.step==='promote-bindings'))throw Error('RESOURCE_PROMOTION_REQUIRES_FORWARD_RECOVERY');return{run,source,sourceFenceMayExist:steps.some(r=>r.step==='fence-source')};},
 };
}
module.exports={createResourceJournal,RESOURCE_STEPS:STEPS,resourceDigest:digest};
