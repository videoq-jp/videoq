const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {createResourceAwsTransport}=require('./d1-resource-aws.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
const run='a'.repeat(32),source='b'.repeat(40),executorSha256='c'.repeat(64),definitionSha256='d'.repeat(64),execution='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
function fixture({enabled=true}={}){
 const calls=[],nativePlan={version:1,run,source,actionId:'e'.repeat(32),projectSha256:'f'.repeat(64),sourceVersion:'immutable-version'},e2e={version:1,nativePlan,apiVersion:'00000000-0000-0000-0000-000000000000',apiBindingsSha256:'1'.repeat(64)};
 const consumers={version:1,operationId:'00000000-0000-0000-0000-000000000001',scope:{purpose:'production'},consumers:['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod'].map((name,i)=>({functionName:name,functionArn:'arn:aws:lambda:ap-northeast-1:257240362763:function:'+name,queueArn:'arn:aws:sqs:ap-northeast-1:257240362763:'+name,mappingUuid:'00000000-0000-0000-0000-'+String(i).padStart(12,'0'),wasEnabled:i!==2}))};
 let fail=false;
 const transport=createResourceAwsTransport({run,source,executorSha256,definitionSha256,mutationsEnabled:enabled,plans:{load:async step=>step==='verify-e2e'?e2e:consumers},env:{PATH:process.env.PATH,HOME:process.env.HOME,AWS_PROFILE:'operator',GH_TOKEN:'github-only',CLOUDFLARE_API_TOKEN:'cloudflare-only',NODE_OPTIONS:'forbidden'},execute:async(program,args,options)=>{
  const file=args.at(-1).slice(7);calls.push({program,args,options,file,input:JSON.parse(await fs.readFile(file,'utf8'))});assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal(options.env.GH_TOKEN,undefined);assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.AWS_PROFILE,'operator');assert.ok(args.includes('--no-paginate'));if(fail)throw Error('PRIVATE_PROVIDER_BODY');return{stdout:'{}'};
 }});
 return{transport,calls,nativePlan,e2e,consumers,fail:()=>fail=true};
}
function claim(){return{TransactItems:[{Update:{TableName:'videoq-db-maintenance-prod',Key:{pk:{S:'run#'+run}},UpdateExpression:'SET resource_executor_sha256 = :executor, resource_revision = :next',ConditionExpression:'execution_arn = :execution AND #kind = :kind AND source_sha = :source AND resource_phase = :holding AND release_requested = :false AND resource_revision = :previous AND attribute_not_exists(resource_executor_sha256) AND attribute_not_exists(resource_steps)',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:execution},':kind':{S:'d1-resource-hold'},':source':{S:source},':holding':{S:'holding'},':false':{BOOL:false},':previous':{N:'0'},':next':{N:'1'},':executor':{S:executorSha256}}}},{ConditionCheck:{TableName:'videoq-db-maintenance-prod',Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:execution},':kind':{S:'d1-resource-hold'}}}}]};}
test('AWS transport admits only fixed run/resource metadata and strips unrelated credentials',async()=>{
 const f=fixture();await f.transport('ddb','GetItem',{TableName:'videoq-db-maintenance-prod',Key:{pk:{S:'run#'+run}},ConsistentRead:true});assert.equal(f.calls.length,1);assert.equal(await fs.stat(f.calls[0].file).then(()=>true,()=>false),false);
 for(const args of [['ssm','GetParameter',{}],['logs','GetLogEvents',{}],['sfn','StopExecution',{executionArn:execution}],['ddb','DeleteItem',{}],['ddb','GetItem',{TableName:'other',Key:{pk:{S:'maintenance'}},ConsistentRead:true}],['codebuild','ListBuildsForProject',{projectName:'videoq-db-smoke-prod',sortOrder:'DESCENDING'}]])await assert.rejects(f.transport(...args),/OPERATION_REFUSED/);assert.equal(f.calls.length,1);
});
test('conditional claim transaction cannot change owner row, field scope, CAS or executor identity',async()=>{
 const f=fixture();await f.transport('ddb','TransactWriteItems',claim());assert.equal(f.calls.length,1);
 for(const mutate of [v=>v.TransactItems[0].Update.Key.pk.S='other',v=>v.TransactItems[0].Update.UpdateExpression='SET private_data=:executor',v=>v.TransactItems[0].Update.ConditionExpression='attribute_exists(pk)',v=>v.TransactItems[0].Update.ExpressionAttributeValues[':executor'].S='0'.repeat(64),v=>v.TransactItems[0].Update.ExpressionAttributeValues[':next'].N='3',v=>v.TransactItems[1]={Delete:{TableName:'videoq-db-maintenance-prod',Key:{pk:{S:'maintenance'}}}}]){const value=claim();mutate(value);await assert.rejects(f.transport('ddb','TransactWriteItems',value),/OPERATION_REFUSED/);}assert.equal(f.calls.length,1);
});
test('mutations default disabled while scoped reads remain available',async()=>{
 const f=fixture({enabled:false});await assert.rejects(f.transport('ddb','TransactWriteItems',claim()),/MUTATIONS_DISABLED/);await f.transport('sfn','DescribeExecution',{executionArn:execution});assert.equal(f.calls.length,1);
});
test('consumer mutation is limited to original production mappings and originally enabled resume',async()=>{
 const f=fixture();await f.transport('lambda','UpdateEventSourceMapping',{UUID:f.consumers.consumers[0].mappingUuid,Enabled:false});
 for(const input of [{UUID:'other',Enabled:false},{UUID:f.consumers.consumers[2].mappingUuid,Enabled:true},{UUID:f.consumers.consumers[0].mappingUuid,Enabled:true,BatchSize:1}])await assert.rejects(f.transport('lambda','UpdateEventSourceMapping',input),/OPERATION_REFUSED/);assert.equal(f.calls.length,1);
});
test('native build overrides pin exact private plan, scope and source without arbitrary role/image/buildspec',async()=>{
 const f=fixture(),variables={MAINTENANCE_RUN_ID:run,MAINTENANCE_SOURCE_SHA:source,MAINTENANCE_STAGE:'smoke',MAINTENANCE_KIND:'smoke',VERIFY_AI_ANSWERS:'true',VIDEOQ_D1_RESOURCE_SMOKE:'true',VIDEOQ_D1_RESOURCE_ACTION_ID:f.nativePlan.actionId,VIDEOQ_D1_RESOURCE_PLAN_SHA256:resourceDigest(f.e2e),VIDEOQ_D1_RESOURCE_EXECUTOR_SHA256:executorSha256,VIDEOQ_D1_RESOURCE_DEFINITION_SHA256:definitionSha256};
 const input={projectName:'videoq-db-smoke-prod',sourceVersion:f.nativePlan.sourceVersion,idempotencyToken:f.nativePlan.actionId,environmentVariablesOverride:Object.entries(variables).map(([name,value])=>({name,value,type:'PLAINTEXT'}))};await f.transport('codebuild','StartBuild',input);
 for(const mutate of [v=>v.buildspecOverride='other',v=>v.sourceVersion='other',v=>v.environmentVariablesOverride[0].value='other',v=>v.projectName='videoq-db-migration-prod']){const value=structuredClone(input);mutate(value);await assert.rejects(f.transport('codebuild','StartBuild',value),/OPERATION_REFUSED/);}assert.equal(f.calls.length,1);
});
test('provider failure is sanitized and private request file removed without retry',async()=>{
 const f=fixture();f.fail();await assert.rejects(f.transport('sts','GetCallerIdentity',{}),{message:'RESOURCE_AWS_REQUEST_FAILED'});assert.equal(f.calls.length,1);assert.equal(await fs.stat(f.calls[0].file).then(()=>true,()=>false),false);
});
