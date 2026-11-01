const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {input, executionArn, safeError} = require('../../infra/db-maintenance/runtime/policy.cjs');
const {createBroker, currentMain} = require('../../infra/db-maintenance/runtime/broker.cjs');
const {definition} = require('../../infra/db-maintenance/state-machine.cjs');
const {assertBuildArn, metadataValue} = require('../../infra/db-maintenance/runtime/job.cjs');
const MACHINE = 'arn:aws:states:ap-northeast-1:257240362763:stateMachine:videoq-db-maintenance-prod';
const SHA = 'a'.repeat(40), RUN = 'b'.repeat(32);
const terminal = status => ({kind: {S: 'rotate'}, name: {S: 'db-' + RUN},
  execution_arn: {S: executionArn(MACHINE, 'db-' + RUN)}, input: {S: '{"kind":"rotate"}'}, created_at: {S: new Date().toISOString()}, status});
function fixture({lock, status = 'RUNNING', active = false, missingBuild = false, missingExecution = false} = {}) {
  const calls = [];
  const aws = async (service, command, value) => {
    calls.push({service, command, value});
    if (command === 'GetItem') return {Item: lock};
    if (command === 'DescribeExecution') {
      if (missingExecution) throw Object.assign(new Error(), {name: 'ExecutionDoesNotExist'});
      return {status};
    }
    if (command === 'ListBuildsForProject') return {ids: ['known-build']};
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
