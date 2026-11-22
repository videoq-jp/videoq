const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');
const {createRequire} = require('node:module');
const {resolve} = require('node:path');
const {input, executionArn, safeError} = require('../../infra/db-maintenance/runtime/policy.cjs');
const {createBroker, currentMain} = require('../../infra/db-maintenance/runtime/broker.cjs');
const {definition} = require('../../infra/db-maintenance/state-machine.cjs');
const {assertBuildArn, metadataValue} = require('../../infra/db-maintenance/runtime/job.cjs');
const {setup} = require('../../infra/db-maintenance/runtime/setup-job.cjs');
const MACHINE = 'arn:aws:states:ap-northeast-1:257240362763:stateMachine:videoq-db-maintenance-prod';
const SHA = 'a'.repeat(40), RUN = 'b'.repeat(32);
test('rotation prepares tools lazily and verifies them before new, resumed, or rollback mutations', async () => {
  async function check(kind, phase, due, failTools = false) {
    const calls = [], filename = resolve('infra/db-maintenance/runtime/job.cjs');
    const nativeRequire = createRequire(filename), module = {exports:{}};
    const journal = {phase, generation:'20261101010101_aabbccdd'};
    const promoted = {...journal, phase:'promoted', retire_after:'2026-11-01T02:42:56Z'};
    const m = {JOURNAL:'journal', readParameter:()=>journal, aws:()=>calls.push('metadata'),
      prepare:async(force, beforeMutation)=>{if(due)beforeMutation(); return phase === 'fresh' ? null : journal;},
      promote:async()=>{calls.push('promote');return promoted;},
      rollback:async()=>{calls.push('rollback');return {phase:'complete'};},
    };
    const fakeRequire = name => name.endsWith('/neon-admin.cjs') ? m : name === './setup-job.cjs'
      ? {installTools:()=>{calls.push('tools');if(failTools)throw new Error('TOOLS_FAILED');}} : nativeRequire(name);
    runInNewContext(readFileSync(filename,'utf8'), {require:fakeRequire,module,console,
      process:{env:{MAINTENANCE_KIND:kind,MAINTENANCE_RUN_ID:RUN,MAINTENANCE_TABLE:'videoq-db-maintenance-prod'}}});
    if(failTools)await assert.rejects(module.exports.prepare(),/TOOLS_FAILED/);
    else await module.exports.prepare();
    return calls;
  }
  assert.deepEqual(await check('rotate','fresh',false),['metadata']);
  assert.deepEqual(await check('rotate','prepared',true),['tools','promote','metadata']);
  assert.deepEqual(await check('rotate','prepared',false),['tools','promote','metadata']);
  assert.deepEqual(await check('rollback','prepared',false),['tools','rollback','metadata']);
  assert.deepEqual(await check('rotate','rollback_pending',false),['tools','rollback','metadata']);
  assert.deepEqual(await check('rotate','prepared',true,true),['tools']);
});
test('job setup preserves verified dependencies for DB operations and installs only the headless browser', () => {
  const execute = (purpose, stage, kind = 'rotate') => {
    const calls = [];
    setup({CODEBUILD_BUILD_ARN: `arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-${purpose}-prod:01234567-89ab-cdef-0123-456789abcdef`,
      MAINTENANCE_STAGE: stage, MAINTENANCE_KIND: kind}, (command, args) => calls.push([command, args]));
    return calls;
  };
  for (const stage of ['retire', 'retire-rollback']) {
    const calls = execute('rotation', stage);
    assert.deepEqual(calls.map(([command, args]) => [command, ...args.slice(0, 2)]), [
      ['npm', 'ci', '--ignore-scripts'], ['npm', 'audit', 'signatures'],
    ]);
  }
  for (const stage of ['prepare', 'complete', 'complete-rollback']) assert.deepEqual(execute('rotation', stage), []);
  assert.deepEqual(execute('rotation', 'prepare', 'audit'), []);
  assert.deepEqual(execute('migration', 'migration'), []);
  for (const purpose of ['backup', 'audit']) assert.equal(execute(purpose, purpose).length, 2);
  assert.deepEqual(execute('smoke', 'smoke', 'smoke')[2], [
    '.github/operations-tools/node_modules/.bin/playwright', ['install', '--only-shell', 'chromium'],
  ]);
  const fontSetup = execute('smoke', 'smoke', 'smoke')[3];
  assert.equal(fontSetup[0], 'sh');
  assert.match(fontSetup[1][2], /fc-list :lang=ja/);
  assert.match(fontSetup[1][2], /--no-install-recommends fonts-ipafont-gothic/);
  assert.throws(() => execute('rotation', 'smoke'), /INVALID_SETUP_STAGE/);
  assert.throws(() => setup({CODEBUILD_BUILD_ARN: 'untrusted'}, () => assert.fail()), /AWS_CODEBUILD_REQUIRED/);
});
const terminal = status => ({kind: {S: 'rotate'}, name: {S: 'db-' + RUN},
  execution_arn: {S: executionArn(MACHINE, 'db-' + RUN)}, input: {S: '{"kind":"rotate"}'}, created_at: {S: new Date().toISOString()}, status});
function fixture({lock, status = 'RUNNING', active = false, missingBuild = false, missingExecution = false, listBuilds} = {}) {
  const calls = [];
  const aws = async (service, command, value) => {
    calls.push({service, command, value});
    if (command === 'GetItem') return {Item: lock};
    if (command === 'DescribeExecution') {
      if (missingExecution) throw Object.assign(new Error(), {name: 'ExecutionDoesNotExist'});
      return {status};
    }
    if (command === 'ListBuildsForProject') {if(value.nextToken&&value.sortOrder)throw Object.assign(Error('Sort order cannot accompany nextToken'),{name:'InvalidInputException'});return listBuilds?listBuilds(value):{ids:['known-build']};}
    if (command === 'BatchGetBuilds') return {builds: missingBuild ? [] : [{buildComplete: !active}]};
    return {};
  };
  const broker = createBroker(aws, {table: 'metadata', machine: MACHINE, projects: ['rotation', 'migration'],
    allowedKinds: ['rotate','rollback','audit','migration','backup','smoke','deploy']}, async () => SHA);
  return {broker, calls};
}
test('the starter rejects buildspec, environment, role, project and source overrides before AWS access', async () => {
  for (const field of ['buildspecOverride','environmentVariablesOverride','serviceRoleOverride','projectName','sourceVersion','DATABASE_URL','__proto__']) {
    const {broker, calls} = fixture();
    const event = JSON.parse(JSON.stringify({action: 'start', kind: 'rotate', [field]: 'attacker-controlled'}));
    await assert.rejects(broker(event), /UNEXPECTED_INPUT/);
    assert.equal(calls.length, 0);
  }
});
test('each invocation endpoint accepts only its configured operations', () => {
  assert.throws(() => input({action:'start',kind:'rotate'}, ['migration']), /OPERATION_NOT_ALLOWED/);
  assert.throws(() => input({action:'start',kind:'migration',source_sha:SHA,writers_stopped:false,force:true}, ['migration']), /INVALID_FORCE/);
  assert.throws(() => input({action:'start',kind:'backup',verify_ai_answers:true}, ['backup']), /INVALID_SMOKE_OPTION/);
  assert.throws(() => input({action:'start',kind:'rotate',source_sha:SHA}, ['rotate']), /UNEXPECTED_SOURCE/);
});
test('migration source must independently match canonical main', async () => {
  const {broker, calls} = fixture();
  await assert.rejects(broker({action:'start',kind:'migration',source_sha:'c'.repeat(40),writers_stopped:false}), /CURRENT_MAIN/);
  assert.deepEqual(calls.map(c => c.command), ['GetItem']);
});
test('accepted starts persist a named execution and a global lock before starting it', async () => {
  const {broker, calls} = fixture();
  const result = await broker({action:'start',kind:'migration',source_sha:SHA,writers_stopped:false});
  assert.equal(result.status, 'RUNNING');
  assert.match(result.run_id, /^[a-f0-9]{32}$/);
  assert.deepEqual(calls.map(c => c.command), ['GetItem','TransactWriteItems','StartExecution']);
  const writes = calls[1].value.TransactItems;
  assert.equal(writes[0].Put.ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(writes[0].Put.Item.pk.S, 'maintenance');
  assert.equal(writes[0].Put.Item.input.S, calls[2].value.input);
  assert.equal(writes[1].Put.Item.execution_arn.S, executionArn(MACHINE, calls[2].value.name));
  assert.equal(JSON.parse(calls[2].value.input).source_sha, SHA);
});
test('running and pending-redrive executions cannot lose their lock', async () => {
  for (const status of ['RUNNING','PENDING_REDRIVE']) {
    const {broker, calls} = fixture({lock: terminal(status), status});
    assert.deepEqual(await broker({action:'start',kind:'rotate'}), {status:'BUSY'});
    assert.deepEqual(calls.map(c => c.command), ['GetItem','DescribeExecution']);
  }
});
test('a missing execution recovers only its stored name/input, without creating a new run', async () => {
  const lock = terminal();
  const {broker, calls} = fixture({lock, missingExecution:true});
  assert.deepEqual(await broker({action:'start',kind:'backup'}), {status:'BUSY'});
  assert.deepEqual(calls[2].value, {stateMachineArn:MACHINE,name:lock.name.S,input:lock.input.S});
  assert.equal(calls.filter(c => c.command === 'StartExecution').length, 1);
  assert.ok(!calls.some(c => c.command === 'DeleteItem'));
});
test('failed rotations block migrations until explicit rotation recovery', async () => {
  const {broker, calls} = fixture({lock:terminal(),status:'FAILED'});
  await assert.rejects(broker({action:'start',kind:'migration',source_sha:SHA,writers_stopped:false}), /ROTATION_RECOVERY_REQUIRED/);
  assert.ok(!calls.some(c => c.command === 'DeleteItem'));
});
test('rotation recovery refuses both active builds and unverified missing build results', async () => {
  for (const flags of [{active:true},{missingBuild:true}]) {
    const {broker, calls} = fixture({lock:terminal(),status:'FAILED',...flags});
    await assert.rejects(broker({action:'start',kind:'rotate'}), /PREVIOUS_BUILD_STILL_RUNNING/);
    assert.ok(!calls.some(c => c.command === 'DeleteItem'));
  }
});
test('recovery may replace only a terminal lock after child builds are confirmed complete', async () => {
  const lock = terminal();
  const {broker, calls} = fixture({lock,status:'FAILED'});
  assert.equal((await broker({action:'start',kind:'rollback'})).status, 'RUNNING');
  const deletion = calls.find(c => c.command === 'DeleteItem').value;
  assert.equal(deletion.ConditionExpression, 'execution_arn = :old');
  assert.deepEqual(deletion.ExpressionAttributeValues[':old'], lock.execution_arn);
  assert.equal(calls.filter(c => c.command === 'BatchGetBuilds').length, 2);
});
test('state-machine metadata contains no secret fetches, preserves grace periods, and tests after retirement', () => {
  const spec = definition({table:'metadata',projects:{rotation:'admin',migration:'migrate',backup:'backup',smoke:'smoke',audit:'audit',deploy:'deploy'}});
  const text = JSON.stringify(spec);
  assert.doesNotMatch(text, /ssm:|GetParameter|DATABASE_URL|password|api_token/);
  assert.equal(spec.States.WaitForInvocations.TimestampPath, '$.decision.payload.retire_after');
  assert.equal(spec.States.Retire.Next, 'SmokeAfterRetirement');
  assert.equal(spec.States.SmokeAfterRetirement.Next, 'Complete');
  assert.equal(spec.States.Complete.Next, 'Release');
  assert.equal(spec.States.RetireRollback.Next, 'SmokeAfterRollbackRetirement');
  assert.equal(spec.States.SmokeAfterRollbackRetirement.Next, 'CompleteRollback');
  assert.equal(spec.States.Release.Parameters.ExpressionAttributeValues[':execution']['S.$'], '$$.Execution.Id');
  assert.equal(spec.States.Deploy.Next, 'SmokeStandalone');
  for (const state of Object.values(spec.States)) {
    if (state.Next) assert.ok(spec.States[state.Next]);
    if (state.Default) assert.ok(spec.States[state.Default]);
    for (const choice of state.Choices || []) assert.ok(spec.States[choice.Next]);
    assert.equal(state.Retry, undefined); // No automatic replay of credential mutations.
  }
});
test('error reporting never forwards arbitrary messages or SDK/SQL error bodies', () => {
  assert.equal(safeError(new Error('password=private-value')), 'MAINTENANCE_REQUEST_FAILED');
  assert.equal(safeError(new Error('KNOWN_FAILURE')), 'KNOWN_FAILURE');
});
test('existing GitHub infrastructure roles cannot write the independent maintenance state', () => {
  const policy = JSON.parse(readFileSync('infra/iam/videoq-tfstate-access.json', 'utf8'));
  const writes = policy.Statement.filter(s => s.Effect === 'Allow' && s.Action.includes('s3:PutObject'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].Resource, [
    'arn:aws:s3:::videoq-terraform-state-<ACCOUNT_ID>/videoq/prod/terraform.tfstate',
    'arn:aws:s3:::videoq-terraform-state-<ACCOUNT_ID>/videoq/prod/terraform.tfstate.tflock',
  ]);
});
test('routine infrastructure updates cannot remove the worker ceiling or recreate its role', () => {
  const policy = JSON.parse(readFileSync('infra/iam/videoq-terraform-deploy.json', 'utf8'));
  const deny = policy.Statement.find(s => s.Sid === 'PreserveOperatorManagedWorkerBoundary');
  assert.equal(deny.Effect, 'Deny');
  for (const action of ['iam:CreateRole','iam:DeleteRole','iam:PutRolePermissionsBoundary','iam:DeleteRolePermissionsBoundary']) assert.ok(deny.Action.includes(action));
  assert.equal(deny.Resource, 'arn:aws:iam::<ACCOUNT_ID>:role/videoq-worker-prod');
  const role = readFileSync('infra/lambda_worker.tf', 'utf8').split('resource "aws_iam_role_policy_attachment"')[0];
  assert.match(role, /ignore_changes = \[permissions_boundary\]/);
});
test('retrying a lost start response observes the existing execution without starting another', async () => {
  const lock = terminal();
  const {broker, calls} = fixture({lock, status:'SUCCEEDED'});
  const result = await broker({action:'start',kind:'rotate',client_token:'c'.repeat(32)});
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(calls.map(c => c.command), ['GetItem','DescribeExecution']);
});
test('missing old execution history cannot cause a stale operation to be replayed', async () => {
  const lock = {...terminal(), created_at: {S: new Date(Date.now()-86400000).toISOString()}};
  const {broker,calls} = fixture({lock,missingExecution:true});
  await assert.rejects(broker({action:'start',kind:'rotate'}), /START_RECOVERY_REQUIRES_REVIEW/);
  assert.ok(!calls.some(c => c.command === 'StartExecution'));
});
test('execution metadata rejects credentials and rounds grace timestamps up', () => {
  assert.throws(() => metadataValue({phase:'promoted',DATABASE_URL:'private'}), /UNSAFE_EXECUTION_METADATA/);
  assert.throws(() => metadataValue({phase:'promoted',generation:'20261101010347_0e38726b'}), /MISSING_EXECUTION_GRACE/);
  const result = metadataValue({phase:'promoted',generation:'20261101010347_0e38726b',retire_after:'2026-11-01T02:42:55.075Z'});
  assert.equal(result.retire_after, '2026-11-01T02:42:56.000Z');
});
test('job context accepts AWS build/project ARNs and rejects other principals and projects', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  assert.doesNotThrow(() => assertBuildArn('arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:' + id));
  for (const arn of [
    'arn:aws:codebuild:ap-northeast-1:257240362763:build:videoq-db-rotation-prod:' + id,
    'arn:aws:codebuild:ap-northeast-1:000000000000:build/videoq-db-rotation-prod:' + id,
    'arn:aws:codebuild:ap-northeast-1:257240362763:build/unreviewed-project:' + id,
  ]) assert.throws(() => assertBuildArn(arn), /AWS_CODEBUILD_REQUIRED/);
});

test('busy migrations do not call the GitHub API', async () => {
  let fetched = false;
  const lock = terminal();
  const aws = async (_, command) => command === 'GetItem' ? {Item: lock} : {status: 'RUNNING'};
  const broker = createBroker(aws, {table:'metadata',machine:MACHINE,projects:[],allowedKinds:['migration']}, async () => {fetched=true;throw new Error('API_UNAVAILABLE');});
  assert.deepEqual(await broker({action:'start',kind:'migration',source_sha:SHA,writers_stopped:false}), {status:'BUSY'});
  assert.equal(fetched,false);
});
test('GitHub HTTP failures expose only a status and never authorize a migration', async () => {
  await assert.rejects(currentMain(async () => ({ok:false,status:403,json(){throw new Error('PRIVATE_BODY');}})), /GITHUB_API_HTTP_403/);
  const invalid = {id:1083911938,owner:{id:1},full_name:'videoq-jp/videoq',default_branch:'main',private:false};
  await assert.rejects(currentMain(async () => ({ok:true,json:async()=>invalid})), /CANONICAL_REPOSITORY_VERIFICATION_FAILED/);
});

test('deployment requires canonical main and failed deployments block database jobs', async () => {
  assert.throws(() => input({action:'start',kind:'deploy',source_sha:'untrusted'}, ['deploy']), /INVALID_DEPLOYMENT_SOURCE/);
  assert.throws(() => input({action:'start',kind:'rotate'}, ['deploy']), /OPERATION_NOT_ALLOWED/);
  const {broker,calls} = fixture();
  await assert.rejects(broker({action:'start',kind:'deploy',source_sha:'c'.repeat(40)}), /CURRENT_MAIN/);
  assert.ok(!calls.some(c => c.command === 'StartExecution'));
  const lock = {...terminal(),kind:{S:'deploy'}};
  await assert.rejects(fixture({lock,status:'FAILED'}).broker({action:'start',kind:'migration',source_sha:SHA,writers_stopped:false}), /DEPLOYMENT_RECOVERY_REQUIRED/);
});

test('managed-login inspection is an explicit read-only audit request with distinct idempotency', async()=>{
  const request={action:'start',kind:'audit',inspection:'postgres-login-fence',client_token:'a'.repeat(32)};
  assert.equal(input(request,['audit']).inspection,'postgres-login-fence');
  for(const event of [{...request,kind:'rotate'},{...request,inspection:'install'},{...request,inspection:{mode:'release'}},{...request,inspection:''}]){
    assert.throws(()=>input(event,['audit','rotate']),/INVALID_AUDIT_INSPECTION/);
  }
  const normal=fixture(),audit=fixture();
  const a=await normal.broker({action:'start',kind:'audit',client_token:request.client_token}),b=await audit.broker(request);
  assert.notEqual(a.run_id,b.run_id);
  const put=audit.calls.find(c=>c.command==='TransactWriteItems').value.TransactItems;
  assert.equal(put[0].Put.Item.inspection.S,'postgres-login-fence');assert.equal(put[1].Put.Item.inspection.S,'postgres-login-fence');
  assert.equal(JSON.parse(audit.calls.find(c=>c.command==='StartExecution').value.input).inspection,'postgres-login-fence');
  const busy=fixture({lock:terminal('RUNNING')});assert.equal((await busy.broker({action:'start',kind:'audit',inspection:'postgres-login-fence'})).status,'BUSY');
  assert.equal(busy.calls.some(c=>c.command==='StartExecution'),false);
});
test('managed-login audit uses only the fixed rotation project and releases only through the existing lock owner check',()=>{
 const spec=definition({table:'metadata',projects:{rotation:'admin',migration:'migrate',backup:'backup',smoke:'smoke',audit:'audit',deploy:'deploy'}});
 const choice=spec.States.Operation.Choices.find(c=>c.Next==='LoginFenceAudit');
 assert.ok(choice.And.some(c=>c.Variable==='$.kind'&&c.StringEquals==='audit'));
 assert.ok(choice.And.some(c=>c.Variable==='$.inspection'&&c.IsPresent===true));
 const job=spec.States.LoginFenceAudit;assert.equal(job.Parameters.ProjectName,'admin');assert.equal(job.Next,'Release');assert.equal(job.ResultPath,null);
 assert.equal(job.Parameters.EnvironmentVariablesOverride.find(v=>v.Name==='MAINTENANCE_STAGE').Value,'login-fence-audit');
 assert.equal(spec.States.Release.Parameters.ConditionExpression,'execution_arn = :execution');
 const calls=[];setup({CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:01234567-89ab-cdef-0123-456789abcdef',MAINTENANCE_STAGE:'login-fence-audit',MAINTENANCE_KIND:'audit'},(command,args)=>calls.push([command,args]));
 assert.equal(calls.length,2);assert.deepEqual(calls[0],['npm',['ci','--ignore-scripts','--prefix','.github/operations-tools']]);
 assert.deepEqual(calls[1],['npm',['audit','signatures','--prefix','.github/operations-tools']]);
});

test('cutover controls are explicitly enabled and cannot carry data-plane overrides',()=>{
 const kinds=['cutover-hold'];
 assert.equal(input({action:'start',kind:'cutover-hold',source_sha:SHA},kinds).source_sha,SHA);
 for(const action of ['release-cutover-hold','recover-cutover-hold']){
  assert.throws(()=>input({action,run_id:RUN},['rotate','audit']),/OPERATION_NOT_ALLOWED/);
  assert.deepEqual(input({action,run_id:RUN},kinds),{action,run_id:RUN});
  assert.throws(()=>input({action,run_id:RUN,cutover_phase:'holding'},kinds),/UNEXPECTED_INPUT/);
 }
 assert.throws(()=>input({action:'start',kind:'cutover-hold',source_sha:SHA,writers_stopped:true},kinds),/INVALID_DEPLOYMENT_SOURCE/);
 const spec=definition({table:'metadata',projects:{}}),read=spec.States.ReadCutoverHold;
 assert.equal(read.Parameters.ProjectionExpression,'cutover_phase,release_requested,consumer_action_id,activity_action_id');
 assert.equal(spec.States.WaitCutoverHold.Next,'ReadCutoverHold');
 assert.equal(spec.States.InvalidCutoverHoldPhase.Type,'Fail');
 assert.equal(spec.States.ReleaseCutoverHold.Parameters.TransactItems[1].Delete.ConditionExpression,'execution_arn = :execution');
 assert.equal(spec.States.ReleaseCutoverHold.Parameters.TransactItems[0].ConditionCheck.ExpressionAttributeValues[':phase'].S,'holding');
});
test('consumer preparation is a fixed maintenance-only action and does not disclose plans in ASL',()=>{
 const {input,HOLD_KIND}=require('../../infra/db-maintenance/runtime/policy.cjs');
 assert.deepEqual(input({action:'prepare-cutover-consumers',run_id:'a'.repeat(32)},[HOLD_KIND]),{action:'prepare-cutover-consumers',run_id:'a'.repeat(32)});
 assert.throws(()=>input({action:'prepare-cutover-consumers',run_id:'a'.repeat(32)},['audit']));
 assert.throws(()=>input({action:'prepare-cutover-consumers',run_id:'a'.repeat(32),stage:'pause'},[HOLD_KIND]));
 const spec=require('../../infra/db-maintenance/state-machine.cjs').definition({table:'test',projects:{rotation:'rotation'}});
 assert.equal(spec.States.PrepareCutoverConsumers.Parameters.ProjectName,'rotation');
 assert.equal(spec.States.ReadCutoverHold.Parameters.ProjectionExpression,'cutover_phase,release_requested,consumer_action_id,activity_action_id');
 assert.equal(spec.States.PrepareCutoverConsumers.Parameters.EnvironmentVariablesOverride.find(v=>v.Name==='MAINTENANCE_STAGE').Value,'cutover-consumer-prepare');
});

test('build completion inventory uses default descending order across every page without incompatible sort overrides',async()=>{
 const {broker,calls}=fixture({lock:terminal(),status:'SUCCEEDED',listBuilds:value=>value.nextToken?{ids:['known-build']}:{ids:['known-build'],nextToken:'older'}});
 assert.equal((await broker({action:'start',kind:'backup'})).status,'RUNNING');
 const pages=calls.filter(c=>c.command==='ListBuildsForProject').map(c=>c.value);
 assert.deepEqual(pages,[{projectName:'rotation'},{projectName:'rotation',nextToken:'older'},{projectName:'migration'},{projectName:'migration',nextToken:'older'}]);
 assert.equal(calls.filter(c=>c.command==='BatchGetBuilds').length,4);
});

test('background verification is an explicit SQS-only migration request carried into the fixed build',async()=>{
 const event={action:'start',kind:'migration',source_sha:SHA,writers_stopped:false,background_verification:true};
 assert.equal(input(event,['migration']).background_verification,true);
 for(const bad of [{...event,kind:'deploy',writers_stopped:undefined},{...event,writers_stopped:true},{...event,background_verification:'true'}])assert.throws(()=>input(bad,['migration','deploy']),/BACKGROUND_VERIFICATION/);
 const f=fixture();await f.broker(event);
 const payload=JSON.parse(f.calls.find(call=>call.command==='StartExecution').value.input);assert.equal(payload.background_verification,true);assert.equal(payload.writers_stopped,false);
 const spec=definition({table:'metadata',projects:{migration:'fixed'},neonRetired:true});
 const field=spec.States.Migrate.Parameters.EnvironmentVariablesOverride.find(row=>row.Name==='MAINTENANCE_BACKGROUND_VERIFICATION');assert.equal(field['Value.$'],"States.Format('{}', $.background_verification)");
});
test('failed migrations retain their exact owner for native redrive instead of allowing a new maintenance run',async()=>{
 for(const status of ['FAILED','TIMED_OUT','ABORTED']){
  const lock={...terminal(),kind:{S:'migration'}};
  for(const request of [{action:'start',kind:'migration',source_sha:SHA,writers_stopped:false},{action:'start',kind:'deploy',source_sha:SHA},{action:'start',kind:'smoke'}]){
   const f=fixture({lock,status});await assert.rejects(f.broker(request),/MIGRATION_RECOVERY_REQUIRED/);
   assert.equal(f.calls.filter(call=>['DeleteItem','TransactWriteItems','StartExecution'].includes(call.command)).length,0);
  }
 }
});
test('verification idempotency cannot silently reuse an ordinary migration or another source',async()=>{
 const event={action:'start',kind:'migration',source_sha:SHA,writers_stopped:false,background_verification:true,client_token:'d'.repeat(32)};
 const row={kind:{S:'migration'},execution_arn:{S:executionArn(MACHINE,'db-'+RUN)},source_sha:{S:SHA},writers_stopped:{BOOL:false},background_verification:{BOOL:true}};
 for(const change of [r=>{r.source_sha.S='e'.repeat(40);},r=>{r.writers_stopped.BOOL=true;},r=>{r.background_verification.BOOL=false;},r=>{delete r.background_verification;}]){
  const value=structuredClone(row);change(value);const f=fixture({lock:value,status:'SUCCEEDED'});await assert.rejects(f.broker(event),/MIGRATION_REQUEST_CHANGED/);assert.equal(f.calls.length,1);
 }
 const f=fixture({lock:row,status:'FAILED'});assert.equal((await f.broker(event)).status,'FAILED');assert.equal(f.calls.filter(call=>call.command==='StartExecution').length,0);
 await assert.rejects(f.broker({...event,background_verification:false}),/MIGRATION_REQUEST_CHANGED/);
});
