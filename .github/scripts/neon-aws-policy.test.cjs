const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {input, executionArn, safeError} = require('../../infra/db-maintenance/runtime/policy.cjs');
const {createBroker} = require('../../infra/db-maintenance/runtime/broker.cjs');
const {definition} = require('../../infra/db-maintenance/state-machine.cjs');
const MACHINE = 'arn:aws:states:ap-northeast-1:257240362763:stateMachine:videoq-db-maintenance-prod';
const SHA = 'a'.repeat(40), RUN = 'b'.repeat(32);
const terminal = status => ({kind: {S: 'rotate'}, name: {S: 'db-' + RUN},
  execution_arn: {S: executionArn(MACHINE, 'db-' + RUN)}, input: {S: '{"kind":"rotate"}'}, status});
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
    allowedKinds: ['rotate','rollback','audit','migration','backup','smoke']}, async () => SHA);
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
  assert.equal(calls.length, 0);
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
  const spec = definition({table:'metadata',projects:{rotation:'admin',migration:'migrate',backup:'backup',smoke:'smoke',audit:'audit'}});
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
