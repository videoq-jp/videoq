// DDB publication is not a completed optimized service-integration task.
const BUILD=/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-rotation-prod:[a-f0-9-]{36}$/;
const EXEC=/^arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-[a-f0-9]{32}$/;
async function stageSucceeded(aws,row){
 const build=row.cutover_last_build_arn?.S;
 if(Object.hasOwn(row,'cutover_last_build_arn')&&(typeof build!=='string'||!BUILD.test(build)))throw Error('INVALID_CUTOVER_STAGE_PROOF');
 if(!build){if(['consumer_prepare_build_arn','consumer_control_build_arn','activity_build_arn','postgres_fence_build_arn'].some(k=>row[k]))throw Error('MISSING_CUTOVER_STAGE_PROOF');return true;}
 if(!BUILD.test(build)||!EXEC.test(row.execution_arn?.S??''))throw Error('INVALID_CUTOVER_STAGE_PROOF');
 let token;const seen=new Set();
 for(let page=0;page<10;page++){
  const result=await aws('sfn','GetExecutionHistory',{executionArn:row.execution_arn.S,reverseOrder:true,includeExecutionData:true,maxResults:1000,...(token?{nextToken:token}:{})});
  if(!Array.isArray(result.events)||result.events.length>1000)throw Error('INCOMPLETE_CUTOVER_STAGE_HISTORY');
  for(const event of result.events){
   const detail=event.taskSucceededEventDetails;if(event.type!=='TaskSucceeded'||detail?.resourceType!=='codebuild'||detail.resource!=='startBuild.sync')continue;
   if(detail.outputDetails?.truncated||typeof detail.output!=='string'||Buffer.byteLength(detail.output)>262144)throw Error('INCOMPLETE_CUTOVER_STAGE_HISTORY');
   let output;try{output=JSON.parse(detail.output);}catch{throw Error('INVALID_CUTOVER_STAGE_HISTORY');}
   if(output.Build?.Arn===build){if(output.Build.Id!==build.split(':build/')[1]||output.Build.BuildStatus!=='SUCCEEDED')throw Error('INVALID_CUTOVER_STAGE_HISTORY');return true;}
  }
  if(!result.nextToken)return false;
  if(typeof result.nextToken!=='string'||seen.has(result.nextToken))throw Error('INCOMPLETE_CUTOVER_STAGE_HISTORY');seen.add(result.nextToken);token=result.nextToken;
 }
 throw Error('INCOMPLETE_CUTOVER_STAGE_HISTORY');
}
async function requireStageSucceeded(aws,row){if(!await stageSucceeded(aws,row))throw Error('CUTOVER_STAGE_STILL_COMPLETING');}
// A redriven task may reuse its committed result, but its NEW build must be the
// native completion being awaited. Never regenerate the original plan/report.
async function acknowledgeReplay({aws,get,table,row,build}){
 if(!BUILD.test(build)||!EXEC.test(row.execution_arn?.S??''))throw Error('INVALID_CUTOVER_STAGE_PROOF');
 if(row.cutover_last_build_arn?.S===build)return;
 if(!/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N??'')||!Number.isSafeInteger(Number(row.cutover_revision.N))||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('INVALID_CUTOVER_STAGE_REVISION');
 const next=String(Number(row.cutover_revision.N)+1),arn=row.execution_arn.S;
 try{await aws('ddb','TransactWriteItems',{TransactItems:[
  {Update:{TableName:table,Key:{pk:row.pk},UpdateExpression:'SET cutover_last_build_arn = :build, #revision = :next',ConditionExpression:'execution_arn = :execution AND source_sha = :source AND #phase = :phase AND #revision = :previous AND release_requested = :false',ExpressionAttributeNames:{'#phase':'cutover_phase','#revision':'cutover_revision'},ExpressionAttributeValues:{':build':{S:build},':next':{N:next},':execution':{S:arn},':source':row.source_sha,':phase':row.cutover_phase,':previous':row.cutover_revision,':false':{BOOL:false}}}},
  {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:'cutover-hold'}}}},
 ]});}catch(error){const[r,o]=await Promise.all([get(row.pk.S),get('maintenance')]);if(r.Item?.cutover_last_build_arn?.S!==build||r.Item.execution_arn?.S!==arn||r.Item.source_sha?.S!==row.source_sha.S||r.Item.cutover_phase?.S!==row.cutover_phase.S||r.Item.cutover_revision?.N!==next||o.Item?.execution_arn?.S!==arn||o.Item.kind?.S!=='cutover-hold')throw error;}
}
module.exports={stageSucceeded,requireStageSucceeded,acknowledgeReplay};
