// Fixed read-only CodeBuild stage. Persist the original admission plan under the
// same live hold before ANY consumer pause is permitted by a later operation.
const {acknowledgeReplay}=require('../../infra/db-maintenance/runtime/stage-proof.cjs');
const {createHash}=require('node:crypto');
const m=require('./neon-admin.cjs');
const {createConsumerControl,validateConsumerPlan}=require('./cutover-sqs-consumers.cjs');
const {consumerPlanPrepared}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
const BUILD=/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-rotation-prod:[a-f0-9-]{36}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
async function prepareConsumers({env=process.env,aws=m.aws}={}) {
  const run=env.MAINTENANCE_RUN_ID,source=env.MAINTENANCE_SOURCE_SHA;
  if(env.MAINTENANCE_KIND!=='cutover-hold'||env.MAINTENANCE_STAGE!=='cutover-consumer-prepare'||env.MAINTENANCE_TABLE!=='videoq-db-maintenance-prod'
    ||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||!BUILD.test(env.CODEBUILD_BUILD_ARN??'')||env.GITHUB_ACTIONS) throw Error('AWS_CONSUMER_PREPARATION_CONTEXT_REQUIRED');
  const table=env.MAINTENANCE_TABLE,arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run,key={pk:{S:'run#'+run}};
  const get=name=>aws('dynamodb','get-item',{TableName:table,Key:{pk:{S:name}},ConsistentRead:true});
  const [record,owner]=await Promise.all([get('run#'+run),get('maintenance')]);const row=record.Item,lock=owner.Item;
  let input;try{input=JSON.parse(lock.input.S);}catch{throw Error('CONSUMER_PREPARATION_OWNERSHIP_REQUIRED');}
  if(row?.kind?.S!=='cutover-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==source||lock?.kind?.S!=='cutover-hold'||lock.execution_arn?.S!==arn
    ||input.kind!=='cutover-hold'||input.source_sha!==source||input.run_id!==run) throw Error('CONSUMER_PREPARATION_OWNERSHIP_REQUIRED');
  const completed=value=>{
    if(!consumerPlanPrepared(value)||!BUILD.test(value.consumer_prepare_build_arn?.S??'')) throw Error('INVALID_CONSUMER_PLAN_RECORD');
    const plan=validateConsumerPlan(JSON.parse(value.consumer_plan.S));if(plan.scope.purpose!=='production') throw Error('INVALID_CONSUMER_PLAN_RECORD');
    return {consumer_prepared:true,consumers:plan.consumers.length,consumer_configuration_changed:false};
  };
  if(row.cutover_phase?.S==='holding'&&consumerPlanPrepared(row)){const result=completed(row);await acknowledgeReplay({aws:(_s,_c,v)=>aws('dynamodb','transact-write-items',v),get,table,row,build:env.CODEBUILD_BUILD_ARN});return result;}
  if(row.cutover_phase?.S!=='consumer-preparing'||row.release_requested?.BOOL!==false||!/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N??'')
    ||!Number.isSafeInteger(Number(row.cutover_revision.N))||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER||consumerPlanPrepared(row)) throw Error('INVALID_CONSUMER_PREPARATION_PHASE');
  // This control instance has no mutation authority and calls prepare only.
  const control=createConsumerControl((command,value)=>{
    if(command!=='ListEventSourceMappings') throw Error('READ_ONLY_CONSUMER_PREPARATION_REQUIRED');
    return aws('lambda','list-event-source-mappings',value);
  });
  const plan=await control.prepare({purpose:'production'}),serialized=JSON.stringify(plan),sha=digest(serialized);
  const values={':execution':{S:arn},':kind':{S:'cutover-hold'},':phase':{S:'consumer-preparing'},':revision':row.cutover_revision,':source':{S:source},':false':{BOOL:false},':plan':{S:serialized},':sha':{S:sha},':build':{S:env.CODEBUILD_BUILD_ARN},':holding':{S:'holding'},':next':{N:String(Number(row.cutover_revision.N)+1)}};
  try {
    await aws('dynamodb','transact-write-items',{TransactItems:[
      {Update:{TableName:table,Key:key,UpdateExpression:'SET consumer_plan = :plan, consumer_plan_sha256 = :sha, consumer_prepare_build_arn = :build, cutover_last_build_arn = :build, #phase = :holding, #revision = :next',
        ConditionExpression:'execution_arn = :execution AND #phase = :phase AND #revision = :revision AND source_sha = :source AND release_requested = :false AND attribute_not_exists(consumer_plan)',
        ExpressionAttributeNames:{'#phase':'cutover_phase','#revision':'cutover_revision'},ExpressionAttributeValues:Object.fromEntries(Object.entries(values).filter(([key])=>key!==':kind'))}},
      {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':values[':execution'],':kind':values[':kind']}}},
    ]});
  } catch(error) {
    const found=(await get('run#'+run)).Item,current=(await get('maintenance')).Item;
    if(found?.execution_arn?.S!==arn||found.source_sha?.S!==source||found.consumer_plan_sha256?.S!==sha||found.consumer_plan?.S!==serialized||found.cutover_phase?.S!=='holding'||current?.execution_arn?.S!==arn) throw error;
    return completed(found);
  }
  const found=(await get('run#'+run)).Item;
  if(found?.execution_arn?.S!==arn||found.source_sha?.S!==source||found.consumer_plan_sha256?.S!==sha||found.consumer_plan?.S!==serialized||found.cutover_phase?.S!=='holding') throw Error('CONSUMER_PREPARATION_READBACK_FAILED');
  return completed(found);
}
module.exports={prepareConsumers};
