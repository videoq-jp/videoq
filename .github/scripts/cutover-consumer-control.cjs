// Fixed pre-database-mutation admission stages. API configuration is read only;
// resuming a different database requires the later verified-backend handoff.
const {createHash}=require('node:crypto');
const m=require('./neon-admin.cjs');
const {createConsumerControl,validateConsumerPlan}=require('./cutover-sqs-consumers.cjs');
const {consumerPlanPrepared}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
const {readDeploymentSettings}=require('./protect-api-deployment.cjs');
const BUILD=/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-rotation-prod:[a-f0-9-]{36}$/;
const hash=s=>createHash('sha256').update(s).digest('hex');
function publicApiState(settings) {
  if(!Array.isArray(settings?.bindings)) throw Error('INVALID_CONSUMER_API_STATE');
  const string=name=>{const matches=settings.bindings.filter(b=>b.name===name);if(matches.length>1||matches.some(b=>b.type!=='plain_text'||typeof b.text!=='string'))throw Error('INVALID_CONSUMER_API_STATE');return matches[0]?.text;};
  if(string('ENVIRONMENT')!=='production') throw Error('INVALID_CONSUMER_API_STATE');
  const vars=Object.fromEntries(['DEPLOYMENT_EDITION','PERSISTENCE_BACKEND','MIGRATION_ALLOW_CLOUD_POSTGRES'].map(name=>[name,string(name)??null]));
  const edition=vars.DEPLOYMENT_EDITION,backend=vars.PERSISTENCE_BACKEND??(edition==='cloud'?'d1':'postgres');
  if(![null,'cloud'].includes(edition)||!['postgres','d1'].includes(backend)||edition==='cloud'&&backend==='postgres'&&vars.MIGRATION_ALLOW_CLOUD_POSTGRES!=='true') throw Error('INVALID_CONSUMER_API_STATE');
  const databases=settings.bindings.filter(b=>b.type==='d1'&&b.name==='DB').map(b=>({name:b.name,id:b.id}));
  const vectors=settings.bindings.filter(b=>b.type==='vectorize'&&['SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768'].includes(b.name)).map(b=>({name:b.name,index_name:b.index_name})).sort((a,b)=>a.name.localeCompare(b.name));
  const hyperdrive=settings.bindings.filter(b=>b.type==='hyperdrive'&&b.name==='HYPERDRIVE').map(b=>({name:b.name,id:b.id}));
  if(backend==='d1'&&(databases.length!==1||typeof databases[0].id!=='string'||vectors.length!==2||new Set(vectors.map(v=>v.name)).size!==2||vectors.some(v=>typeof v.index_name!=='string'||!v.index_name))) throw Error('INVALID_CONSUMER_API_STATE');
  if(backend==='postgres'&&(hyperdrive.length!==1||typeof hyperdrive[0].id!=='string'||!hyperdrive[0].id)) throw Error('INVALID_CONSUMER_API_STATE');
  return {serialized:JSON.stringify({vars,databases,vectors,hyperdrive}),traffic:string('MIGRATION_TRAFFIC_STATE')};
}
async function controlConsumers({env=process.env,aws=m.aws,readParameter=m.readParameter,fetcher=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}={}) {
  const stage=env.MAINTENANCE_STAGE,pause=stage==='cutover-consumer-pause',resume=stage==='cutover-consumer-resume',run=env.MAINTENANCE_RUN_ID,action=env.MAINTENANCE_CONSUMER_ACTION_ID,source=env.MAINTENANCE_SOURCE_SHA;
  if(env.VIDEOQ_CUTOVER_CONSUMER_CONTROL!=='true'||!pause&&!resume||env.MAINTENANCE_KIND!=='cutover-hold'||env.MAINTENANCE_TABLE!=='videoq-db-maintenance-prod'||env.GITHUB_ACTIONS
    ||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{32}$/.test(action??'')||!/^[a-f0-9]{40}$/.test(source??'')||!BUILD.test(env.CODEBUILD_BUILD_ARN??'')) throw Error('AWS_CONSUMER_CONTROL_CONTEXT_REQUIRED');
  const table=env.MAINTENANCE_TABLE,arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run,active=pause?'consumers-pausing':'consumers-resuming',complete=pause?'consumers-paused':'holding';
  const get=name=>aws('dynamodb','get-item',{TableName:table,Key:{pk:{S:name}},ConsistentRead:true});
  let planSha;
  async function owned(allowComplete=false) {
    const [r,o]=await Promise.all([get('run#'+run),get('maintenance')]);const row=r.Item,owner=o.Item;
    if(row?.kind?.S!=='cutover-hold'||row.execution_arn?.S!==arn||row.source_sha?.S!==source||row.consumer_action_id?.S!==action||row.database_mutations_started?.BOOL!==false||row.release_requested?.BOOL!==false
      ||owner?.kind?.S!=='cutover-hold'||owner.execution_arn?.S!==arn||!consumerPlanPrepared(row)||!BUILD.test(row.consumer_prepare_build_arn?.S??'')
      ||row.cutover_phase?.S!==active&&!(allowComplete&&row.cutover_phase?.S===complete)) throw Error('CONSUMER_CONTROL_OWNERSHIP_REQUIRED');
    if(row.api_traffic_plan&&(pause?(row.api_pause_verified?.BOOL!==true||row.api_admission_restored?.BOOL!==false):(row.api_admission_restored?.BOOL!==true||row.api_pause_verified?.BOOL!==false)))throw Error('VERIFIED_API_TRAFFIC_REQUIRED');
    if(planSha&&row.consumer_plan_sha256.S!==planSha) throw Error('CONSUMER_CONTROL_PLAN_CHANGED');
    return row;
  }
  let row=await owned(true);planSha=row.consumer_plan_sha256.S;const plan=validateConsumerPlan(JSON.parse(row.consumer_plan.S));if(plan.scope.purpose!=='production')throw Error('INVALID_CONSUMER_CONTROL_PLAN');
  const secret=await readParameter('/videoq/security/prod/cutover-control');
  if(secret.CLOUDFLARE_ACCOUNT_ID!=='12daec56fdba43f677f2766ee26a5a39'||typeof secret.CLOUDFLARE_API_TOKEN!=='string'||secret.CLOUDFLARE_API_TOKEN.length<20||secret.CLOUDFLARE_API_TOKEN.length>4096||/[\r\n\0]/.test(secret.CLOUDFLARE_API_TOKEN)) throw Error('INVALID_CONSUMER_CONTROL_CREDENTIAL');
  const cf={CLOUDFLARE_ACCOUNT_ID:secret.CLOUDFLARE_ACCOUNT_ID,CLOUDFLARE_API_TOKEN:secret.CLOUDFLARE_API_TOKEN};
  async function apiSafe(expected) {
    const current=publicApiState(await readDeploymentSettings(cf,fetcher));
    if(expected!==undefined&&current.serialized!==expected) throw Error('CONSUMER_BACKEND_HANDOFF_REQUIRED');
    if(pause?current.traffic!=='paused':![undefined,'running'].includes(current.traffic)) throw Error('CONSUMER_API_TRAFFIC_STATE_REQUIRED');
    if(resume){
      const response=await fetcher('https://videoq.jp/ready',{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!response.ok||!response.body)throw Error('CONSUMER_API_NOT_READY');
      const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>8192)throw Error('CONSUMER_API_NOT_READY');chunks.push(Buffer.from(chunk));}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(body.data?.status!=='ready'||body.data?.db!=='ok')throw Error('CONSUMER_API_NOT_READY');
    }
    return current.serialized;
  }
  const baseline=value=>{
    if(typeof value.consumer_pause_api_state?.S!=='string'||hash(value.consumer_pause_api_state.S)!==value.consumer_pause_api_sha256?.S) throw Error('INVALID_CONSUMER_BACKEND_RECORD');
    return value.consumer_pause_api_state.S;
  };
  const control=createConsumerControl((command,value)=>{
    const commands={ListEventSourceMappings:'list-event-source-mappings',UpdateEventSourceMapping:'update-event-source-mapping'};
    if(!commands[command])throw Error('INVALID_CONSUMER_CONTROL_COMMAND');return aws('lambda',commands[command],value);
  },{assertOwnership:async()=>{const current=await owned();await apiSafe(baseline(current));}});
  if(row.cutover_phase.S===complete){
    const state=await control.inspect(plan);
    if(pause?!state.admissionPaused:!state.originalAdmissionRestored||row.consumer_admission_restored?.BOOL!==true) throw Error('CONSUMER_COMPLETION_DRIFT');
    if(resume)await apiSafe(baseline(row));
    return pause?{consumers_paused:true,drained:false}:{consumers_restored:true,drained:false};
  }
  const currentApi=await apiSafe(row.consumer_pause_api_state?baseline(row):undefined);
  if(!row.consumer_pause_api_state){
    if(!pause)throw Error('INVALID_CONSUMER_BACKEND_RECORD');
    await aws('dynamodb','transact-write-items',{TransactItems:[
      {Update:{TableName:table,Key:{pk:{S:'run#'+run}},UpdateExpression:'SET consumer_pause_api_state = :state, consumer_pause_api_sha256 = :sha',
        ConditionExpression:'#phase = :phase AND consumer_action_id = :action AND execution_arn = :execution AND database_mutations_started = :false AND release_requested = :false AND attribute_not_exists(consumer_pause_api_state)',
        ExpressionAttributeNames:{'#phase':'cutover_phase'},ExpressionAttributeValues:{':state':{S:currentApi},':sha':{S:hash(currentApi)},':phase':{S:active},':action':{S:action},':execution':{S:arn},':false':{BOOL:false}}}},
      {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution',ExpressionAttributeValues:{':execution':{S:arn}}}},
    ]});
    row=await owned();
  }
  await control[pause?'pause':'resume'](plan);
  const end=now()+180000;let state=await control.inspect(plan);
  while(!(pause?state.admissionPaused:state.originalAdmissionRestored)){
    if(now()>=end)throw Error('CONSUMER_TRANSITION_INCOMPLETE');
    const current=await owned();await apiSafe(baseline(current));await sleep(1000);state=await control.inspect(plan);
  }
  row=await owned();await apiSafe(baseline(row));
  if(!/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N??'')||!Number.isSafeInteger(Number(row.cutover_revision.N))||Number(row.cutover_revision.N)>=Number.MAX_SAFE_INTEGER)throw Error('INVALID_CONSUMER_CONTROL_REVISION');
  try{
    await aws('dynamodb','transact-write-items',{TransactItems:[
      {Update:{TableName:table,Key:{pk:{S:'run#'+run}},UpdateExpression:'SET #phase = :complete, #revision = :next, consumer_admission_restored = :restored, consumer_control_build_arn = :build',
        ConditionExpression:'execution_arn = :execution AND #phase = :active AND #revision = :previous AND consumer_action_id = :action AND consumer_plan_sha256 = :plan AND database_mutations_started = :false AND release_requested = :false',
        ExpressionAttributeNames:{'#phase':'cutover_phase','#revision':'cutover_revision'},ExpressionAttributeValues:{':complete':{S:complete},':next':{N:String(Number(row.cutover_revision.N)+1)},':restored':{BOOL:resume},':build':{S:env.CODEBUILD_BUILD_ARN},':execution':{S:arn},':active':{S:active},':previous':row.cutover_revision,':action':{S:action},':plan':{S:planSha},':false':{BOOL:false}}}},
      {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution',ExpressionAttributeValues:{':execution':{S:arn}}}},
    ]});
  }catch(error){const found=await owned(true);if(found.cutover_phase.S!==complete||found.consumer_admission_restored?.BOOL!==resume)throw error;}
  return pause?{consumers_paused:true,drained:false}:{consumers_restored:true,drained:false};
}
module.exports={controlConsumers,publicApiState};
