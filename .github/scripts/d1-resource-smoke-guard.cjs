// AWS-native metadata guard. No secret reads, builds or lock mutations here.
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const TABLE='videoq-db-maintenance-prod',KIND='d1-resource-hold';
function createResourceSmokeGuard({env=process.env,aws,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 if(env.VIDEOQ_D1_RESOURCE_SMOKE===undefined||env.VIDEOQ_D1_RESOURCE_SMOKE==='false')return{wait:async()=>{},assert:async()=>{}};
 if(env.VIDEOQ_D1_RESOURCE_SMOKE!=='true'||typeof aws!=='function'||env.GITHUB_ACTIONS||env.MAINTENANCE_KIND!=='smoke'||env.MAINTENANCE_STAGE!=='smoke'||env.MAINTENANCE_TABLE!==TABLE||env.VIDEOQ_D1_PRODUCTION_SMOKE!=='true'||env.VERIFY_AI_ANSWERS!=='true'||!/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-smoke-prod:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(env.CODEBUILD_BUILD_ARN??''))throw Error('RESOURCE_SMOKE_CONTEXT_REQUIRED');
 const run=env.MAINTENANCE_RUN_ID,source=env.MAINTENANCE_SOURCE_SHA,action=env.VIDEOQ_D1_RESOURCE_ACTION_ID,plan=env.VIDEOQ_D1_RESOURCE_PLAN_SHA256,executor=env.VIDEOQ_D1_RESOURCE_EXECUTOR_SHA256,definition=env.VIDEOQ_D1_RESOURCE_DEFINITION_SHA256,version=env.CODEBUILD_SOURCE_VERSION;
 if(!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{32}$/.test(action??'')||!/^[a-f0-9]{40}$/.test(source??'')||[plan,executor,definition].some(value=>!/^[a-f0-9]{64}$/.test(value??''))||typeof version!=='string'||!version||version.length>1024)throw Error('RESOURCE_SMOKE_PINNED_CONTEXT_REQUIRED');
 const arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
 async function check(allowRegistration=false){
  const [record,owner,execution,bound]=await Promise.all([
   aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:'run#'+run}},ConsistentRead:true}),aws('ddb','GetItem',{TableName:TABLE,Key:{pk:{S:'maintenance'}},ConsistentRead:true}),
   aws('sfn','DescribeExecution',{executionArn:arn}),aws('sfn','DescribeStateMachineForExecution',{executionArn:arn}),
  ]);
  const row=record.Item;let steps,spec;
  try{steps=JSON.parse(row.resource_steps.S);spec=JSON.parse(bound.definition);}catch{throw Error('RESOURCE_SMOKE_JOURNAL_REQUIRED');}
  const index=RESOURCE_STEPS.indexOf('verify-e2e');
  if(row.kind?.S!==KIND||row.execution_arn?.S!==arn||row.source_sha?.S!==source||row.resource_phase?.S!=='holding'||row.release_requested?.BOOL!==false||row.resource_executor_sha256?.S!==executor||owner.Item?.kind?.S!==KIND||owner.Item.execution_arn?.S!==arn||execution.status!=='RUNNING'||resourceDigest(spec)!==definition||!Array.isArray(steps)||steps.length!==index+1||resourceDigest(steps)!==row.resource_steps_sha256?.S||steps.some((step,i)=>step.step!==RESOURCE_STEPS[i]||step.state!==(i===index?'intent':'verified'))||steps[index].planSha256!==plan||row.resource_smoke_action_id?.S!==action||row.resource_smoke_plan_sha256?.S!==plan||row.resource_smoke_source_version?.S!==version)throw Error('RESOURCE_SMOKE_LIVE_OWNERSHIP_REQUIRED');
  if(row.resource_smoke_build_arn?.S===env.CODEBUILD_BUILD_ARN)return true;
  if(allowRegistration&&!row.resource_smoke_build_arn&&row.resource_smoke_state?.S==='starting')return false;
  throw Error('RESOURCE_SMOKE_BUILD_REGISTRATION_REQUIRED');
 }
 return{
  async wait(){for(let attempt=0;attempt<120;attempt++){if(await check(true))return;await sleep(1000);}throw Error('RESOURCE_SMOKE_BUILD_REGISTRATION_REQUIRED');},
  async assert(){await check();},
 };
}
module.exports={createResourceSmokeGuard};
