// Read-only native-build provenance checks. No build start, log/SSM read or
// app credential handling. The caller separately binds stable API state.
const {randomBytes}=require('node:crypto');
const {resourceDigest}=require('./d1-resource-journal.cjs');
const PROJECT='videoq-db-smoke-prod';
const ARN=/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-smoke-prod:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const flags=new Set(['MAINTENANCE_TABLE','VIDEOQ_CUTOVER_CONSUMER_CONTROL','VIDEOQ_CUTOVER_FINAL_HANDOFF','VIDEOQ_CUTOVER_POSTWRITE_RECOVERY','VIDEOQ_D1_PRODUCTION_SMOKE','VIDEOQ_RETAIN_BACKUP','VIDEOQ_EXPORT_D1_FROM_BACKUP']);
function environment(rows){
 if(!Array.isArray(rows)||rows.some(row=>!row||typeof row.name!=='string'||typeof row.value!=='string'||row.type!=='PLAINTEXT')||new Set(rows.map(row=>row.name)).size!==rows.length)throw Error('RESOURCE_NATIVE_ENVIRONMENT_REQUIRED');
 return Object.fromEntries(rows.map(row=>[row.name,row.value]));
}
function projectState(project,source){
 const reviewed=project?.tags?.filter(row=>row.key==='ReviewedSource');
 if(project?.name!==PROJECT||project.source?.type!=='S3'||typeof project.sourceVersion!=='string'||!project.sourceVersion||project.sourceVersion.length>1024||reviewed?.length!==1||reviewed[0].value!==source||project.concurrentBuildLimit!==1)throw Error('RESOURCE_NATIVE_REVIEWED_PROJECT_REQUIRED');
 const variables=environment(project.environment?.environmentVariables);
 if(Object.keys(variables).some(key=>!flags.has(key))||variables.MAINTENANCE_TABLE!=='videoq-db-maintenance-prod'||variables.VIDEOQ_D1_PRODUCTION_SMOKE!=='true')throw Error('RESOURCE_NATIVE_D1_PROJECT_REQUIRED');
 const {environmentVariables,...runtime}=project.environment;
 return{source:project.source,sourceVersion:project.sourceVersion,serviceRole:project.serviceRole,runtime,variables};
}
function timestamp(value){return value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN;}
function createResourceSmokeProof({aws,assertExecutor,run,source,executorSha256,definitionSha256}){
 if(typeof aws!=='function'||typeof assertExecutor!=='function'||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||[executorSha256,definitionSha256].some(value=>!/^[a-f0-9]{64}$/.test(value??'')))throw Error('RESOURCE_NATIVE_CONTEXT_REQUIRED');
 async function project(){
  const response=await aws('codebuild','BatchGetProjects',{names:[PROJECT]});
  if(response.projectsNotFound?.length||response.projects?.length!==1)throw Error('RESOURCE_NATIVE_PROJECT_REQUIRED');
  return projectState(response.projects[0],source);
 }
 function validatePlan(plan){
  if(!plan||Object.keys(plan).sort().join(',')!=='actionId,notBefore,projectSha256,run,source,sourceVersion,version'||plan.version!==1||!/^[a-f0-9]{32}$/.test(plan.actionId??'')||plan.run!==run||plan.source!==source||typeof plan.sourceVersion!=='string'||!plan.sourceVersion||!/^[a-f0-9]{64}$/.test(plan.projectSha256??'')||typeof plan.notBefore!=='string'||!Number.isFinite(Date.parse(plan.notBefore)))throw Error('RESOURCE_NATIVE_PLAN_REQUIRED');
 }
 return{
  async prepare(notBefore){
   await assertExecutor();if(typeof notBefore!=='string'||!Number.isFinite(Date.parse(notBefore)))throw Error('RESOURCE_NATIVE_RESUME_TIME_REQUIRED');
   const state=await project();await assertExecutor();
   return{version:1,run,source,actionId:randomBytes(16).toString('hex'),notBefore,sourceVersion:state.sourceVersion,projectSha256:resourceDigest(state)};
  },
  async verify(plan,buildArn,stepPlanSha256){
   validatePlan(plan);if(!ARN.test(buildArn??'')||!/^[a-f0-9]{64}$/.test(stepPlanSha256??''))throw Error('RESOURCE_NATIVE_BUILD_REQUIRED');
   await assertExecutor();
   const [state,response]=await Promise.all([project(),aws('codebuild','BatchGetBuilds',{ids:[buildArn]})]);
   if(state.sourceVersion!==plan.sourceVersion||resourceDigest(state)!==plan.projectSha256)throw Error('RESOURCE_NATIVE_PROJECT_CHANGED');
   const build=response.builds?.[0];
   if(response.buildsNotFound?.length||response.builds?.length!==1||build.arn!==buildArn||build.projectName!==PROJECT||build.buildStatus!=='SUCCEEDED'||build.buildComplete!==true||build.sourceVersion!==plan.sourceVersion||build.serviceRole!==state.serviceRole||resourceDigest(build.source)!==resourceDigest(state.source)||!Number.isFinite(timestamp(build.startTime))||!Number.isFinite(timestamp(build.endTime))||timestamp(build.startTime)<Date.parse(plan.notBefore)||timestamp(build.endTime)<timestamp(build.startTime))throw Error('RESOURCE_NATIVE_SUCCESSFUL_BUILD_REQUIRED');
   const {environmentVariables,...runtime}=build.environment??{};
   const expected={...state.variables,MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_STAGE:'smoke',MAINTENANCE_KIND:'smoke',VERIFY_AI_ANSWERS:'true',VIDEOQ_D1_RESOURCE_SMOKE:'true',VIDEOQ_D1_RESOURCE_ACTION_ID:plan.actionId,VIDEOQ_D1_RESOURCE_PLAN_SHA256:stepPlanSha256,VIDEOQ_D1_RESOURCE_EXECUTOR_SHA256:executorSha256,VIDEOQ_D1_RESOURCE_DEFINITION_SHA256:definitionSha256};
   if(resourceDigest(runtime)!==resourceDigest(state.runtime)||resourceDigest(environment(environmentVariables))!==resourceDigest(expected))throw Error('RESOURCE_NATIVE_FIXED_EXECUTION_REQUIRED');
   await assertExecutor();
   const receipt={version:1,run,source,actionId:plan.actionId,stepPlanSha256,executorSha256,definitionSha256,projectSha256:plan.projectSha256,sourceVersion:plan.sourceVersion,buildArn,startedAt:new Date(build.startTime).toISOString(),completedAt:new Date(build.endTime).toISOString(),verifyAiAnswers:true};
   return{receipt,receiptSha256:resourceDigest(receipt)};
  },
 };
}
module.exports={createResourceSmokeProof};
