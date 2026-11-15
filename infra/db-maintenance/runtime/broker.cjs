// This Lambda holds no database credentials. It accepts operations, never build overrides.
const {randomBytes, createHash} = require('node:crypto');
const {REGION, REPOSITORY, HOLD_KIND, KINDS, input, executionArn, safeError} = require('./policy.cjs');
const {createCutoverHoldControl,consumerPlanPrepared} = require('./cutover-hold.cjs');
function createBroker(aws, configuration, fetchMain = currentMain) {
  const {table, machine, projects, allowedKinds, consumerControlEnabled=false, expectedDefinitionHash} = configuration;
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
      let nextToken;const tokens=new Set();
      for (let page=0;page<25;page++) {
        const listed = await aws('codebuild', 'ListBuildsForProject', {projectName, sortOrder:'DESCENDING', ...(nextToken?{nextToken}:{})});
        const ids=listed.ids??[];
        if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'))throw new Error('BUILD_INVENTORY_INCOMPLETE');
        if(ids.length){
          const {builds}=await aws('codebuild','BatchGetBuilds',{ids});
          if(!builds||builds.length!==ids.length||builds.some(build=>build.buildComplete!==true))throw new Error('PREVIOUS_BUILD_STILL_RUNNING');
        }
        if(!listed.nextToken)break;
        if(typeof listed.nextToken!=='string'||tokens.has(listed.nextToken)||page===24)throw new Error('BUILD_INVENTORY_INCOMPLETE');
        nextToken=listed.nextToken;tokens.add(nextToken);
      }
    }
  }
  async function assertOwnedHold(run, arn, source) {
    const [{Item: owner},{Item: row}] = await Promise.all([get('maintenance'),get('run#'+run)]);
    if (owner?.execution_arn?.S !== arn || owner.kind?.S !== HOLD_KIND || row?.kind?.S !== HOLD_KIND
      || row.execution_arn?.S !== arn || row.source_sha?.S !== source || row.cutover_phase?.S !== 'holding') throw new Error('CUTOVER_HOLD_OWNERSHIP_LOST');
    if (row.release_requested?.BOOL !== false) throw new Error('CUTOVER_HOLD_RELEASE_REQUESTED');
  }
  const control = createCutoverHoldControl({aws, table, machine, get, noActiveBuilds, consumerControlEnabled, expectedDefinitionHash});
  return async event => {
    const request = input(event, allowedKinds);
    if (request.action !== 'start' && request.action !== 'status') return control(request);
    if (request.action === 'status') {
      const {Item} = await get('run#' + request.run_id);
      if (!Item || !allowedKinds.includes(Item.kind.S)) throw new Error('UNKNOWN_RUN');
      if (Item.kind.S === HOLD_KIND && Item.cutover_phase?.S === 'recovered') return {run_id:request.run_id,status:'RECOVERED'};
      const state = await aws('sfn', 'DescribeExecution', {executionArn: Item.execution_arn.S});
      const prepared = Item.kind.S === HOLD_KIND && state.status === 'RUNNING' && Item.cutover_phase?.S === 'holding' && Item.release_requested?.BOOL === false && consumerPlanPrepared(Item);
      if (prepared) await assertOwnedHold(request.run_id, Item.execution_arn.S, Item.source_sha.S);
      const paused = Item.kind.S === HOLD_KIND && state.status === 'RUNNING' && Item.cutover_phase?.S === 'consumers-paused';
      if (paused) {
        const {Item: owner} = await get('maintenance');
        if (owner?.execution_arn?.S !== Item.execution_arn.S || owner.kind?.S !== HOLD_KIND || Item.database_mutations_started?.BOOL !== false || Item.consumer_admission_restored?.BOOL !== false || !consumerPlanPrepared(Item)) throw new Error('CUTOVER_HOLD_OWNERSHIP_LOST');
      }
      const restored = prepared && Item.consumer_admission_restored?.BOOL === true;
      return {run_id: request.run_id, status: state.status, ...(prepared ? {consumer_prepared:true} : {}), ...(paused ? {consumers_paused:true} : {}), ...(restored ? {consumers_restored:true} : {})};
    }
    const run_id = request.client_token
      ? createHash('sha256').update(request.kind + ':' + (request.inspection ? request.inspection + ':' : '') + request.client_token).digest('hex').slice(0, 32)
      : randomBytes(16).toString('hex');
    if (request.client_token) {
      const {Item: existing} = await get('run#' + run_id);
      if (existing) {
        if (existing.kind.S !== request.kind || (existing.inspection?.S || '') !== (request.inspection || '')) throw new Error('RUN_KIND_MISMATCH');
        if (request.kind === HOLD_KIND && existing.source_sha?.S !== request.source_sha) throw new Error('CUTOVER_HOLD_SOURCE_CHANGED');
        if (request.kind === HOLD_KIND && existing.cutover_phase?.S !== 'holding') throw new Error('CUTOVER_RECOVERY_REQUIRED');
        try {
          const state = await aws('sfn', 'DescribeExecution', {executionArn: existing.execution_arn.S});
          if (request.kind === HOLD_KIND && state.status === 'RUNNING') await assertOwnedHold(run_id, existing.execution_arn.S, request.source_sha);
          return {run_id, status: state.status};
        } catch (error) {
          if (error.name !== 'ExecutionDoesNotExist') throw error;
          const {Item: pending} = await get('maintenance');
          if (!pending || pending.execution_arn.S !== existing.execution_arn.S) throw new Error('START_RECOVERY_REQUIRES_REVIEW');
          return {run_id, status: (await execution(pending)).status};
        }
      }
    }
    let buildsChecked = false;
    const {Item: lock} = await get('maintenance');
    if (lock) {
      if (!KINDS.includes(lock.kind?.S)) throw new Error('UNKNOWN_MAINTENANCE_LOCK');
      const previous = await execution(lock);
      if (!['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'].includes(previous.status)) return {status: 'BUSY'};
      if (lock.kind.S === HOLD_KIND) throw new Error('CUTOVER_RECOVERY_REQUIRED');
      const failedRotation = ['rotate', 'rollback'].includes(lock.kind.S) && previous.status !== 'SUCCEEDED';
      if (failedRotation && !['rotate', 'rollback'].includes(request.kind)) throw new Error('ROTATION_RECOVERY_REQUIRED');
      if (lock.kind.S === 'deploy' && previous.status !== 'SUCCEEDED' && request.kind !== 'deploy') throw new Error('DEPLOYMENT_RECOVERY_REQUIRED');
      await noActiveBuilds(); buildsChecked = true;
      await aws('ddb', 'DeleteItem', {TableName: table, Key: {pk: {S: 'maintenance'}},
        ConditionExpression: 'execution_arn = :old', ExpressionAttributeValues: {':old': lock.execution_arn}});
    }
    if (request.kind === HOLD_KIND && !buildsChecked) await noActiveBuilds();
    // Waiting requests must not spend GitHub's anonymous API quota.
    if (['migration','deploy',HOLD_KIND].includes(request.kind) && await fetchMain() !== request.source_sha) throw new Error('SOURCE_MUST_MATCH_CURRENT_MAIN');
    const name = 'db-' + run_id;
    const arn = executionArn(machine, name);
    const payload = JSON.stringify({source_sha: '', writers_stopped: false, verify_ai_answers: false, ...request, run_id});
    const item = {kind: {S: request.kind}, execution_arn: {S: arn}, ...(request.inspection ? {inspection: {S: request.inspection}} : {})};
    try {
      await aws('ddb', 'TransactWriteItems', {TransactItems: [
        {Put: {TableName: table, Item: {pk: {S: 'maintenance'}, ...item, name: {S: name}, input: {S: payload}, created_at: {S: new Date().toISOString()}}, ConditionExpression: 'attribute_not_exists(pk)'}},
        {Put: {TableName: table, Item: {pk: {S: 'run#' + run_id}, ...item, ...(request.kind === HOLD_KIND ? {source_sha:{S:request.source_sha},cutover_phase:{S:'holding'},cutover_revision:{N:'0'},release_requested:{BOOL:false},database_mutations_started:{BOOL:false}} : {expires_at: {N: String(Math.floor(Date.now()/1000)+90*86400)}})}, ConditionExpression: 'attribute_not_exists(pk)'}},
      ]});
    } catch (error) {
      if (error.name === 'TransactionCanceledException') return {status: 'BUSY'};
      throw error;
    }
    // A failed invocation retains the named lock; a retry recovers this exact execution.
    await aws('sfn', 'StartExecution', {stateMachineArn: machine, name, input: payload});
    if (request.kind === HOLD_KIND) await assertOwnedHold(run_id, arn, request.source_sha);
    return {run_id, status: 'RUNNING'};
  };
}
async function currentMain(fetcher = fetch) {
  const options = () => ({headers: {'User-Agent': 'videoq-aws-db-maintenance', Accept: 'application/vnd.github+json'}, redirect: 'error', signal: AbortSignal.timeout(15000)});
  const identity = await fetcher('https://api.github.com/repositories/1083911938', options());
  if (!identity.ok) throw new Error('GITHUB_API_HTTP_' + identity.status);
  const repository = await identity.json();
  if (repository.id !== 1083911938 || repository.owner?.id !== 349188820 || repository.full_name !== REPOSITORY || repository.default_branch !== 'main' || repository.private !== false) throw new Error('CANONICAL_REPOSITORY_VERIFICATION_FAILED');
  const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/git/ref/heads/main`, options());
  if (!response.ok) throw new Error('GITHUB_API_HTTP_' + response.status);
  const data = await response.json();
  if (!/^[a-f0-9]{40}$/.test(data.object?.sha || '')) throw new Error('MAIN_SOURCE_VERIFICATION_FAILED');
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
        consumerControlEnabled: process.env.CUTOVER_CONSUMER_CONTROL_ENABLED === 'true', projects: JSON.parse(process.env.BUILD_PROJECTS), allowedKinds: process.env.ALLOWED_KINDS.split(',')});
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
