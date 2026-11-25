/** Bounded, fixed-target disposable rehearsal driver. Never prints credentials. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import releasePreflight from '../../../../.github/scripts/embedding-release-preflight.cjs';
const name='videoq-acceptance-20261125-c33d',account='12daec56fdba43f677f2766ee26a5a39';
const origin=`https://${name}.yukiharada1228.workers.dev`;
const directory=process.env.ACCEPTANCE_PRIVATE_DIR;
if(!directory) throw Error('ACCEPTANCE_PRIVATE_DIR required');
const config=JSON.parse(readFileSync(directory+'/wrangler.json','utf8'));
assert.equal(config.name,name);assert.equal(config.account_id,account);assert(!config.routes);assert(!config.env);
assert.equal(config.d1_databases.length,1);assert.equal(config.d1_databases[0].database_name,name);
const database=config.d1_databases[0].database_id;assert(/^[a-f0-9-]{36}$/.test(database));
assert.equal(config.r2_buckets.length,1);assert.equal(config.vectorize.length,1);assert.equal(config.workflows.length,1);
assert.equal(config.r2_buckets[0].bucket_name,name);assert.equal(config.vectorize[0].index_name,name);
assert(!config.hyperdrive);assert(!config.services);
if(config.queues){assert.equal(config.queues.consumers.length,1);assert.equal(config.queues.consumers[0].queue,name);assert(config.queues.producers.every(value=>[name,name+'-dlq'].includes(value.queue)));}
assert.equal(config.workflows[0].name,name);
const state=JSON.parse(readFileSync(directory+'/private.json','utf8'));
const output=process.env.ACCEPTANCE_REPORT_PATH ?? directory+'/receipt.json';
const hash=value=>createHash('sha256').update(value).digest('hex');
const jobId=process.env.ACCEPTANCE_JOB_ID??'isolated-recovery-v2';assert(/^isolated-recovery-v[234]$/.test(jobId));
const videoId=Number(process.env.ACCEPTANCE_JOB_VIDEO??1);assert([1,2].includes(videoId));
const job={type:'reindex_video_transcript',job_id:jobId,payload:{video_id:videoId}};
// canonicalBackgroundJob keys and whitespace match the production contract.
const canonical=JSON.stringify({payload:job.payload,type:job.type});
const workflowId=hash(job.job_id+'\n'+canonical);
const privateSave=()=>writeFileSync(directory+'/private.json',JSON.stringify(state),{mode:0o600});
function oauth() {
 if(process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
 const contents=readFileSync(process.env.HOME+'/Library/Preferences/.wrangler/config/default.toml','utf8');
 const token=contents.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];if(!token) throw Error('Cloudflare authentication missing');return token;
}
async function cf(path,method='GET',body,allowMissing=false) {
 assert(path.startsWith('/accounts/'+account+'/'));
 const response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+oauth(),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=await response.json();if(allowMissing&&response.status===404)return {alreadyAbsent:true};if(!response.ok||json.success===false)throw Error('Cloudflare fixture operation failed: '+response.status+' '+JSON.stringify(json.errors?.map(e=>({code:e.code,message:e.message}))));return json.result;
}
async function sql(query,params=[]) {return (await cf(`/accounts/${account}/d1/database/${database}/query`,'POST',{sql:query,params}))[0];}
async function app(path,method='GET',body,authenticated=true) {
 assert(path.startsWith('/'));
 const response=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(120000),headers:{'content-type':'application/json',...(authenticated?{cookie:state.cookie??''}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return response;
}
async function rpc(name,input,mutation=false,authenticated=true) {
 const path='/api/trpc/admin.'+name+(mutation?'':'?input='+encodeURIComponent(JSON.stringify(input)));
 const response=await app(path,mutation?'POST':'GET',mutation?input:undefined,authenticated);
 const json=await response.json();return {status:response.status,data:json.result?.data,error:json.error?.data?.code};
}
async function signIn() {
 const response=await fetch(origin+'/api/auth/sign-in/email',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'acceptance@example.test',password:state.password})});
 if(response.status!==200) {await response.body?.cancel();throw Error('Isolated sign in failed '+response.status);}
 state.cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');privateSave();return {status:response.status,cookieFlags:response.headers.getSetCookie().every(value=>value.includes('HttpOnly'))};
}
const remoteDatabase=await cf(`/accounts/${account}/d1/database/${database}`);assert.equal(remoteDatabase.name,name);
const wrangler=new URL('../../../../node_modules/.bin/wrangler',import.meta.url).pathname;
function cli(args) {return execFileSync(wrangler,[...args,'--config',directory+'/wrangler.json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});}
const command=process.argv[2];
const report=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):{};
report.identity={sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),configSha256:hash(JSON.stringify(config)),workerSourceSha256:hash(readFileSync(config.main)),account,worker:name,database,index:name,bucket:name,workflow:name,workflowId,model:'@cf/google/embeddinggemma-2',dimensions:768,productionModified:false};
report.operations??=[];
let result;
if(command==='configure-fixture') {
 const sinkConfig=JSON.parse(readFileSync(directory+'/wrangler.sink.json','utf8'));assert.equal(sinkConfig.name,name+'-sink');assert.equal(sinkConfig.account_id,account);assert.equal(sinkConfig.d1_databases[0].database_id,database);
 for(const [key,value,path] of [['BETTER_AUTH_SECRET',state.authSecret,directory+'/wrangler.json'],['OPERATIONAL_POLICY_WEBHOOK_TOKEN',state.notificationToken,directory+'/wrangler.json'],['ACCEPTANCE_SINK_TOKEN',state.notificationToken,directory+'/wrangler.sink.json']]) {
  assert(typeof value==='string'&&value.length>=32);try{execFileSync(wrangler,['secret','put',key,'--config',path],{input:value,encoding:'utf8',stdio:['pipe','pipe','pipe']});}catch{throw Error('Fixture secret configuration failed');}
 }
 result={configuredSecretBindings:3,valuesWithheld:true};
}
else if(command==='seed-fixture') {
 const seed=readFileSync(directory+'/seed.sql','utf8');assert(seed.includes('recovery_probe'));await sql(seed);
 result={users:(await sql("SELECT count(*) AS n FROM users WHERE id='owner'")).results[0].n,videos:(await sql('SELECT count(*) AS n FROM videos WHERE id IN(1,2)')).results[0].n};
}
else if(command==='sign-in') result=await signIn();
else if(command==='status') result=await cf(`/accounts/${account}/workflows/${name}/instances/${workflowId}`);
else if(command==='create-workflow') result=await cf(`/accounts/${account}/workflows/${name}/instances`,'POST',{instance_id:workflowId,params:job});
else if(command==='inspect') {result=await rpc('inspectSearchRecovery',{job});if(result.status===200){state.inspection=result.data.inspection;privateSave();}}
else if(command==='restart') {
 assert(state.inspection);const denied=await rpc('restartSearchWorkflow',{job,inspection:'0'.repeat(64)},true);assert.notEqual(denied.status,200);
 const unauthorized=await rpc('restartSearchWorkflow',{job,inspection:state.inspection},true,false);assert.notEqual(unauthorized.status,200);
 await sql("UPDATE recovery_probe SET mode='run'");const start=performance.now();result={denied,unauthorized,restart:await rpc('restartSearchWorkflow',{job,inspection:state.inspection},true),requestMs:performance.now()-start};state.restartAt=Date.now();privateSave();
}
else if(['real-provenance','auth-check','delete-check','state','policy-observe','replay','outbox','reindex-real','snapshot','disrupt','restore-artifacts','maintain','reconcile'].includes(command)) {const response=await app('/acceptance/'+command,'POST',{});result={status:response.status,data:await response.json()};if(command==='disrupt'){state.disruptedAt=Date.now();privateSave();}}
else if(command==='verify') {
 const workflow=await cf(`/accounts/${account}/workflows/${name}/instances/${workflowId}`);
 const ledger=await sql("SELECT job_id,job_type,status,attempts FROM job_executions WHERE job_id=?",[job.job_id]);
 const heads=await sql('SELECT h.video_id,h.dimensions,r.source_revision,r.embedding_fingerprint FROM video_index_heads h JOIN scene_index_runs r ON r.id=h.run_id');
 const tasks=await sql('SELECT operation,dimensions,accepted_at,completed_at,verified_at,last_error_code FROM scene_index_tasks');
 const scenes=await sql('SELECT id,video_id,dimensions,revision,vector_id FROM scenes');
 const forbidden=await rpc('inspectSearchRecovery',{job},false,false);
 result={workflowStatus:workflow.status,ledger:ledger.results,heads:heads.results,tasks:tasks.results,scenes:scenes.results,unauthorizedStatus:forbidden.status,resumeElapsedMs:state.restartAt?Date.now()-state.restartAt:null};
}
else if(command==='pause') {
 const paused=cli(['queues','pause-delivery',name]);
 config.vars.MIGRATION_TRAFFIC_STATE='paused';writeFileSync(directory+'/wrangler.json',JSON.stringify(config,null,2));
 const deployment=cli(['deploy']);writeFileSync(directory+'/pause.log',deployment);
 let stopped;const propagationDeadline=Date.now()+60000;do{stopped=await app('/ready','GET',undefined,false);if(stopped.status===503)break;await stopped.body?.cancel();await new Promise(resolve=>setTimeout(resolve,1000));}while(Date.now()<propagationDeadline);assert.equal(stopped.status,503);
 const workflows=await cf(`/accounts/${account}/workflows/${name}/instances`);
 const active=(Array.isArray(workflows)?workflows:workflows.instances??[]).filter(row=>['queued','running','waiting'].includes(row.status));assert.equal(active.length,0);
 result={queuePaused:true,pauseReceiptSha256:hash(paused),newTrafficStatus:stopped.status,activeWorkflows:active.length,workerVersion:deployment.match(/Current Version ID: ([a-f0-9-]+)/)?.[1]};
}
else if(command==='refresh-policy-triggers') {
 const migration=readFileSync(new URL('../../drizzle-d1/0022_policy_observation.sql',import.meta.url),'utf8');
 const triggerSql='CREATE TRIGGER'+migration.split('CREATE TRIGGER').slice(1).join('CREATE TRIGGER');const names=[...triggerSql.matchAll(/CREATE TRIGGER (policy_[a-z_]+)/g)].map(match=>match[1]);assert.equal(names.length,7);
 const columns=(await sql('PRAGMA table_info(policy_readiness)')).results.map(row=>row.name);
 for(const [column,type] of [['ready_fingerprint','TEXT'],['ready_dimensions','INTEGER'],['ready_run_id','TEXT']]) if(!columns.includes(column)) await sql('ALTER TABLE policy_readiness ADD COLUMN '+column+' '+type);
 const statements=names.map(value=>'DROP TRIGGER IF EXISTS '+value+';').join('\n')+triggerSql;
 await sql(statements);result={triggerNames:names,migrationSha256:hash(migration),scope:'disposable previously migrated fixture only'};
}
else if(command==='seed-scale') {const ids=Array.from({length:998},(_,i)=>i+3);const inserted=await sql("INSERT OR IGNORE INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) SELECT value,'owner','Synthetic scope video '||value,'','','2026-11-25T00:00:00Z','','completed','','upload','','' FROM json_each(?)",[JSON.stringify(ids)]);result={changes:inserted.meta?.changes,distribution:'1000 video metadata rows; two transcribed scenes, one pending at freeze'};}
else if(command==='drain') {
 const deadline=Date.now()+30000;let active;
 do {
  active=(await sql(`SELECT
   (SELECT count(*) FROM job_executions WHERE status='running' AND julianday(lease_until)>julianday('now')) AS jobs,
   (SELECT count(*) FROM external_tasks WHERE completed_at IS NULL AND locked_at IS NOT NULL AND julianday(locked_at)>julianday('now','-5 minutes')) AS outbox,
   (SELECT count(*) FROM scene_index_tasks WHERE completed_at IS NULL AND lease_token IS NOT NULL AND julianday(lease_until)>julianday('now')) AS indexes`)).results[0];
  if(Object.values(active).every(value=>value===0))break;
  await new Promise(resolve=>setTimeout(resolve,1000));
 }while(Date.now()<deadline);
 assert(Object.values(active).every(value=>value===0));result={activeLeases:active,drainObservedAt:new Date().toISOString(),limit:'fixture producers stopped; managed in-flight delivery count not exported'};
}
else if(command==='seed-outbox') {const row=await sql("INSERT OR IGNORE INTO external_tasks(kind,payload,dedupe_key) VALUES('sqs_job',?,?)",[JSON.stringify({message:{type:'reindex_video_transcript',job_id:'isolated-recovery-v2',payload:{video_id:1}}}),'synthetic-frozen-outbox-replay:'+jobId]);result={changes:row.meta?.changes};}
else if(command==='bookmark') {
 const bookmark=JSON.parse(cli(['d1','time-travel','info',name,'--json']));state.bookmark=bookmark.bookmark??bookmark.current_bookmark;assert(state.bookmark);state.snapshotAt=Date.now();privateSave();result={bookmark:state.bookmark,snapshotAt:state.snapshotAt};
}
else if(command==='export') {
 const path=directory+'/snapshot.sql';writeFileSync(path,'',{mode:0o600});cli(['d1','export',name,'--remote','--output',path,'--skip-confirmation']);result={sqlSha256:hash(readFileSync(path)),bytes:readFileSync(path).length};
}
else if(command==='restore-db') {
 assert(state.bookmark);state.restoreStartedAt=Date.now();privateSave();
 const restored=JSON.parse(cli(['d1','time-travel','restore',name,'--bookmark',state.bookmark,'--json']));result={restored,elapsedMs:Date.now()-state.restoreStartedAt,syntheticLossWindowMs:state.disruptedAt-state.snapshotAt};
}
else if(command==='resume') {
 assert.equal(config.vars.MIGRATION_TRAFFIC_STATE,'paused');
 const reconciliationResponse=await app('/acceptance/reconcile','POST',{});assert.equal(reconciliationResponse.status,200);
 const reconciliation=await reconciliationResponse.json();
 for(const key of ['objectsEqual','vectorsEqual','postSnapshotMarkerLost','corruptionReverted']) assert.equal(reconciliation[key],true);
 const provenance=await releasePreflight.preflight(config,{CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:oauth()},fetch,{resume:true});
 assert.equal(provenance.serving,true);assert.equal(provenance.dimensions,768);
 config.vars.MIGRATION_TRAFFIC_STATE='running';writeFileSync(directory+'/wrangler.json',JSON.stringify(config,null,2));const deployment=cli(['deploy']);writeFileSync(directory+'/resume.log',deployment);cli(['queues','resume-delivery',name]);
 result={reconciliation,provenance,queueResumed:true,workerVersion:deployment.match(/Current Version ID: ([a-f0-9-]+)/)?.[1],restoreToResumeMs:state.restoreStartedAt?Date.now()-state.restoreStartedAt:null};
}
else if(command==='cleanup') {
 const emptied=await app('/acceptance/cleanup-objects','POST',{});assert([200,410].includes(emptied.status));const objects=emptied.status===200?await emptied.json():{retiredWorker:true,remaining:null};if(emptied.status===200)assert.equal(objects.remaining,0);
 const actions=[];
 cli(['queues','pause-delivery',name]);
 const consumerRemoval=cli(['queues','consumer','worker','remove',name,name]);actions.push({operation:'remove own queue consumer',receiptSha256:hash(consumerRemoval)});
 const workflowDeletion=await cf(`/accounts/${account}/workflows/${name}`,'DELETE',undefined,true);actions.push({operation:'delete workflow',alreadyAbsent:workflowDeletion?.alreadyAbsent===true});
 // Retire both owned DO namespaces/storage explicitly before deleting their Worker.
 const bindings=config.durable_objects?.bindings??[];
 assert.deepEqual(bindings.map(value=>value.class_name).sort(),['RateLimiter','TaskScheduler']);assert(bindings.every(value=>!value.script_name));
 const retirement={...config,main:new URL('./cleanup.worker.ts',import.meta.url).pathname,durable_objects:{bindings:[]},workflows:[],migrations:[...config.migrations,{tag:'acceptance-retire-20261125',deleted_classes:['RateLimiter','TaskScheduler']}]};delete retirement.queues;
 const retirementPath=directory+'/wrangler.retire.json';writeFileSync(retirementPath,JSON.stringify(retirement,null,2));
 const retirementReceipt=execFileSync(wrangler,['deploy','--config',retirementPath],{encoding:'utf8',stdio:['ignore','pipe','pipe']});actions.push({operation:'retire owned Durable Object namespaces',receiptSha256:hash(retirementReceipt)});
 await cf(`/accounts/${account}/workers/services/${name}?force=false`,'DELETE');actions.push({operation:'delete isolated worker without forcing dependencies',accepted:true});
 for(const args of [['queues','delete',name],['queues','delete',name+'-dlq'],['vectorize','delete',name,'--force'],['r2','bucket','delete',name]]) {
  const receipt=cli(args);actions.push({operation:args.slice(0,3).join(' '),receiptSha256:hash(receipt)});
 }
 await cf(`/accounts/${account}/workers/services/${name}-sink?force=false`,'DELETE');actions.push({operation:'delete isolated sink without forcing dependencies',accepted:true});
 const db=cli(['d1','delete',name,'--skip-confirmation']);actions.push({operation:'delete D1',receiptSha256:hash(db)});
 result={objects,actions,productionModified:false};
}
else if(command==='measure') {
 const cells=[];
 for(const size of [1,100,1000]) for(const concurrency of [1,2]) {
  const samples=[];let cold;
  const request=async()=>{const start=performance.now();const response=await app('/acceptance/measure','POST',{size});const json=await response.json();return {status:response.status,clientElapsedMs:performance.now()-start,...json};};
  cold=await request();
  for(let i=0;i<4;i+=concurrency) samples.push(...await Promise.all(Array.from({length:Math.min(concurrency,4-i)},request)));
  cells.push({tenantVideoCount:size,concurrency,coldLogical:cold,samples});
 }
 result={cells,samplesPerCell:4,coldDefinition:'first request per cell; not controlled isolate/provider cold start',inputSha256:hash('What is sampling according to the lesson? Answer in one sentence and cite the lesson.'),limits:['HTTP endpoint composes native auth with actual streamRag, excludes native chat HTTP billing/rate-limit/course setup','24 warm requests plus 6 first requests, 1/100/1000 selected-video scopes; one relevant scene','No production SLO or statistically reliable p99 from four samples','Provider timings are binding response availability, not additive with total token streaming time']};
}
else throw Error('Expected sign-in/create-workflow/status/inspect/restart/verify/measure');
// Never persist API instance logs/output (may include scene text) in public receipts.
if(command==='status') result={id:result.id,status:result.status,versionId:result.version_id,errorName:result.error?.name,errorCode:result.error?.message?.slice(0,200)};
report.operations.push({command,identity:report.identity,at:new Date().toISOString(),result});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({command,reportPath:output,status:result.status??result.workflowStatus??'recorded'}));
