// This Lambda holds no database credentials. It accepts operations, never build overrides.
const {randomBytes, createHash} = require('node:crypto');
const {REGION, REPOSITORY, input, executionArn, safeError} = require('./policy.cjs');
function createBroker(aws, configuration, fetchMain = currentMain) {
  const {table, machine, projects, allowedKinds} = configuration;
  const get = key => aws('ddb', 'GetItem', {TableName: table, Key: {pk: {S: key}}, ConsistentRead: true});
  async function execution(lock) {
    try { return await aws('sfn', 'DescribeExecution', {executionArn: lock.execution_arn.S}); }
    catch (error) {
      if (error.name !== 'ExecutionDoesNotExist') throw error;
      const created = Date.parse(lock.created_at?.S);
      if (!Number.isFinite(created) || Date.now() - created < 0 || Date.now() - created > 300000) throw new Error('START_RECOVERY_REQUIRES_REVIEW');
      // The lock names the execution before StartExecution. Recover a crashed start
      // using the SAME name/input only after AWS proves that execution is absent.
      await aws('sfn', 'StartExecution', {stateMachineArn: machine, name: lock.name.S, input: lock.input.S});
      return {status: 'RUNNING'};
    }
  }
  async function noActiveBuilds() {
    for (const projectName of projects) {
      const listed = await aws('codebuild', 'ListBuildsForProject', {projectName, sortOrder: 'DESCENDING'});
      if (listed.ids?.length) {
        const {builds} = await aws('codebuild', 'BatchGetBuilds', {ids: listed.ids.slice(0, 100)});
        if (!builds || builds.length !== listed.ids.slice(0, 100).length || builds.some(build => !build.buildComplete)) throw new Error('PREVIOUS_BUILD_STILL_RUNNING');
      }
    }
  }
  return async event => {
    const request = input(event, allowedKinds);
    if (request.action === 'status') {
      const {Item} = await get('run#' + request.run_id);
      if (!Item || !allowedKinds.includes(Item.kind.S)) throw new Error('UNKNOWN_RUN');
      const state = await aws('sfn', 'DescribeExecution', {executionArn: Item.execution_arn.S});
      return {run_id: request.run_id, status: state.status};
    }
    const run_id = request.client_token
      ? createHash('sha256').update(request.kind + ':' + request.client_token).digest('hex').slice(0, 32)
      : randomBytes(16).toString('hex');
    if (request.client_token) {
      const {Item: existing} = await get('run#' + run_id);
      if (existing) {
        if (existing.kind.S !== request.kind) throw new Error('RUN_KIND_MISMATCH');
        try {
          const state = await aws('sfn', 'DescribeExecution', {executionArn: existing.execution_arn.S});
          return {run_id, status: state.status};
        } catch (error) {
          if (error.name !== 'ExecutionDoesNotExist') throw error;
          const {Item: pending} = await get('maintenance');
          if (!pending || pending.execution_arn.S !== existing.execution_arn.S) throw new Error('START_RECOVERY_REQUIRES_REVIEW');
          return {run_id, status: (await execution(pending)).status};
        }
      }
    }
    if (request.kind === 'migration' && await fetchMain() !== request.source_sha) throw new Error('MIGRATION_MUST_MATCH_CURRENT_MAIN');
    const {Item: lock} = await get('maintenance');
    if (lock) {
      const previous = await execution(lock);
      if (!['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'].includes(previous.status)) return {status: 'BUSY'};
      const failedRotation = ['rotate', 'rollback'].includes(lock.kind.S) && previous.status !== 'SUCCEEDED';
      if (failedRotation && !['rotate', 'rollback'].includes(request.kind)) throw new Error('ROTATION_RECOVERY_REQUIRED');
      await noActiveBuilds();
      await aws('ddb', 'DeleteItem', {TableName: table, Key: {pk: {S: 'maintenance'}},
        ConditionExpression: 'execution_arn = :old', ExpressionAttributeValues: {':old': lock.execution_arn}});
    }
    const name = 'db-' + run_id;
    const arn = executionArn(machine, name);
    const payload = JSON.stringify({source_sha: '', writers_stopped: false, verify_ai_answers: false, ...request, run_id});
    const item = {kind: {S: request.kind}, execution_arn: {S: arn}};
    try {
      await aws('ddb', 'TransactWriteItems', {TransactItems: [
        {Put: {TableName: table, Item: {pk: {S: 'maintenance'}, ...item, name: {S: name}, input: {S: payload}, created_at: {S: new Date().toISOString()}}, ConditionExpression: 'attribute_not_exists(pk)'}},
        {Put: {TableName: table, Item: {pk: {S: 'run#' + run_id}, ...item, expires_at: {N: String(Math.floor(Date.now()/1000)+90*86400)}}, ConditionExpression: 'attribute_not_exists(pk)'}},
      ]});
    } catch (error) {
      if (error.name === 'TransactionCanceledException') return {status: 'BUSY'};
      throw error;
    }
    // A failed invocation retains the named lock; a retry recovers this exact execution.
    await aws('sfn', 'StartExecution', {stateMachineArn: machine, name, input: payload});
    return {run_id, status: 'RUNNING'};
  };
}
async function currentMain() {
  const options = () => ({headers: {'User-Agent': 'videoq-aws-db-maintenance', Accept: 'application/vnd.github+json'}, redirect: 'error', signal: AbortSignal.timeout(15000)});
  const identity = await fetch('https://api.github.com/repositories/1083911938', options());
  const repository = await identity.json();
  if (!identity.ok || repository.id !== 1083911938 || repository.owner?.id !== 349188820 || repository.full_name !== REPOSITORY || repository.default_branch !== 'main' || repository.private !== false) throw new Error('CANONICAL_REPOSITORY_VERIFICATION_FAILED');
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/git/ref/heads/main`, options());
  const data = await response.json();
  if (!response.ok || !/^[a-f0-9]{40}$/.test(data.object?.sha || '')) throw new Error('MAIN_SOURCE_VERIFICATION_FAILED');
  return data.object.sha;
}
let broker;
exports.handler = async event => {
  try {
    if (!broker) {
      const ddb = require('@aws-sdk/client-dynamodb'), sfn = require('@aws-sdk/client-sfn'), cb = require('@aws-sdk/client-codebuild');
      const services = {ddb: [new ddb.DynamoDBClient({region: REGION}), ddb], sfn: [new sfn.SFNClient({region: REGION}), sfn], codebuild: [new cb.CodeBuildClient({region: REGION}), cb]};
      const aws = (service, command, value) => services[service][0].send(new services[service][1][command + 'Command'](value));
      broker = createBroker(aws, {table: process.env.MAINTENANCE_TABLE, machine: process.env.STATE_MACHINE_ARN,
        projects: JSON.parse(process.env.BUILD_PROJECTS), allowedKinds: process.env.ALLOWED_KINDS.split(',')});
    }
    return await broker(event);
  } catch (error) {
    const reason = safeError(error);
    console.error('Database maintenance request failed: ' + reason);
    return {status: 'REJECTED', reason};
  }
};
exports.createBroker = createBroker;
exports.currentMain = currentMain;
