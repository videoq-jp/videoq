const {createHash,randomBytes}=require('node:crypto');
// This is a maintenance hold, not a database write fence. Release is permitted
// only in holding with no unfinished consumer/DB mutation. No credential or task token is stored.
const {HOLD_KIND, executionArn} = require('./policy.cjs');
const TERMINAL = new Set(['FAILED','TIMED_OUT','ABORTED','MISSING']);
function consumerPlanPrepared(row) {
  if (!row?.consumer_plan && !row?.consumer_plan_sha256) return false;
  if (typeof row.consumer_plan?.S !== 'string' || !/^[a-f0-9]{64}$/.test(row.consumer_plan_sha256?.S ?? '')
    || createHash('sha256').update(row.consumer_plan.S).digest('hex') !== row.consumer_plan_sha256.S) throw new Error('INVALID_CONSUMER_PLAN_RECORD');
  return true;
}
function definitionHash(value) {
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function createCutoverHoldControl({aws, table, machine, get, noActiveBuilds, consumerControlEnabled=false, expectedDefinitionHash}) {
  function checked(row, run) {
    const arn = executionArn(machine, 'db-' + run);
    if (row?.pk?.S !== 'run#'+run || row?.kind?.S !== HOLD_KIND || row.execution_arn?.S !== arn || !/^[a-f0-9]{40}$/.test(row.source_sha?.S || '')
      || !['holding','consumer-preparing','consumers-pausing','consumers-paused','consumers-resuming','recovering','recovered'].includes(row.cutover_phase?.S)
      || !/^(0|[1-9][0-9]*)$/.test(row.cutover_revision?.N || '')
      || !Number.isSafeInteger(Number(row.cutover_revision.N)) || Number(row.cutover_revision.N) >= Number.MAX_SAFE_INTEGER
      || typeof row.release_requested?.BOOL !== 'boolean') throw new Error('INVALID_CUTOVER_HOLD_RECORD');
    for (const field of ['database_mutations_started','consumer_admission_restored','deployment_admission_restored']) {
      if (Object.hasOwn(row,field) && typeof row[field]?.BOOL !== 'boolean') throw new Error('INVALID_CUTOVER_HOLD_RECORD');
    }
    return arn;
  }
  async function describe(arn) {
    try { return (await aws('sfn','DescribeExecution',{executionArn:arn})).status; }
    catch (error) { if (error.name === 'ExecutionDoesNotExist') return 'MISSING'; throw error; }
  }
  function updated(row, phase) {
    return {...row, cutover_phase:{S:phase}, cutover_revision:{N:String(Number(row.cutover_revision.N)+1)}};
  }
  async function replace(run, before, after, owner, removeOwner = false) {
    const arn = before.execution_arn.S;
    const writes = [{Put:{TableName:table,Item:after,
      ConditionExpression:'execution_arn = :execution AND #phase = :phase AND #revision = :revision',
      ExpressionAttributeNames:{'#phase':'cutover_phase','#revision':'cutover_revision'},
      ExpressionAttributeValues:{':execution':{S:arn},':phase':before.cutover_phase,':revision':before.cutover_revision}}}];
    if (owner?.execution_arn?.S === arn) {
      const parameters = {TableName:table,ConditionExpression:'execution_arn = :execution AND #kind = :kind',
        ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{S:arn},':kind':{S:HOLD_KIND}}};
      writes.push(removeOwner ? {Delete:{...parameters,Key:{pk:{S:'maintenance'}}}} : {Put:{...parameters,Item:owner}});
    }
    try { await aws('ddb','TransactWriteItems',{TransactItems:writes}); }
    catch (error) { if (error.name === 'TransactionCanceledException') throw new Error('CUTOVER_HOLD_STATE_CHANGED'); throw error; }
  }
  return async request => {
    const mutationAction = ['pause-cutover-consumers','resume-cutover-consumers','retry-cutover-consumers'].includes(request.action);
    if (mutationAction && !consumerControlEnabled) throw new Error('CUTOVER_CONSUMER_CONTROL_DISABLED');
    const run = request.run_id;
    let row = (await get('run#'+run)).Item;
    const arn = checked(row,run);
    let owner = (await get('maintenance')).Item;
    if (row.cutover_phase.S === 'recovered') {
      if (owner?.execution_arn?.S === arn || !TERMINAL.has(row.cutover_execution_status?.S)) throw new Error('CUTOVER_HOLD_OWNERSHIP_LOST');
      return {run_id:run,status:'RECOVERED',execution_status:row.cutover_execution_status.S};
    }
    let status = await describe(arn);
    if (mutationAction) {
      const expected=expectedDefinitionHash??require('./cutover-definition.json').sha256;
      if(!/^[a-f0-9]{64}$/.test(expected??''))throw new Error('INVALID_CUTOVER_DEFINITION_PIN');
      const bound=await aws('sfn','DescribeStateMachineForExecution',{executionArn:arn});
      if(typeof bound.definition!=='string'||definitionHash(JSON.parse(bound.definition))!==expected)throw new Error('CUTOVER_EXECUTION_DEFINITION_MISMATCH');
      if (owner?.execution_arn?.S !== arn || owner.kind?.S !== HOLD_KIND || row.release_requested.BOOL || row.database_mutations_started?.BOOL !== false || !consumerPlanPrepared(row)) throw new Error('CUTOVER_MUTATION_RECOVERY_REQUIRED');
      if (request.action === 'retry-cutover-consumers') {
        if (!['consumers-pausing','consumers-paused','consumers-resuming'].includes(row.cutover_phase.S) || !/^[a-f0-9]{32}$/.test(row.consumer_action_id?.S ?? '')) throw new Error('INVALID_CONSUMER_RETRY_PHASE');
        if (status === 'RUNNING' || status === 'PENDING_REDRIVE') return {run_id:run,status:'RUNNING',consumer_retry_accepted:true};
        if (!['FAILED','TIMED_OUT','ABORTED'].includes(status)) throw new Error('CUTOVER_EXECUTION_NOT_REDRIVABLE');
        await noActiveBuilds();
        const details = await aws('sfn','DescribeExecution',{executionArn:arn});
        const count = details.redriveCount ?? 0;
        if (!['FAILED','TIMED_OUT','ABORTED'].includes(details.status) || details.redriveStatus !== 'REDRIVABLE' || !Number.isSafeInteger(count) || count < 0) throw new Error('CUTOVER_EXECUTION_NOT_REDRIVABLE');
        const [{Item: current},{Item: currentOwner}] = await Promise.all([get('run#'+run),get('maintenance')]);
        if (current?.execution_arn?.S !== arn || current.cutover_phase?.S !== row.cutover_phase.S || current.cutover_revision?.N !== row.cutover_revision.N || current.consumer_action_id?.S !== row.consumer_action_id.S || currentOwner?.execution_arn?.S !== arn || currentOwner.kind?.S !== HOLD_KIND || current.source_sha?.S !== row.source_sha.S || current.consumer_plan_sha256?.S !== row.consumer_plan_sha256.S || current.database_mutations_started?.BOOL !== false || current.release_requested?.BOOL !== false) throw new Error('CUTOVER_HOLD_STATE_CHANGED');
        const token = createHash('sha256').update('consumer-redrive:'+arn+':'+row.cutover_phase.S+':'+row.consumer_action_id.S+':'+count).digest('hex');
        if (row.consumer_redrive_token?.S !== token) await replace(run,row,{...updated(row,row.cutover_phase.S),consumer_redrive_token:{S:token}},owner);
        try { await aws('sfn','RedriveExecution',{executionArn:arn,clientToken:token}); }
        catch(error) { const after=await describe(arn);if(!['RUNNING','PENDING_REDRIVE'].includes(after))throw error; }
        return {run_id:run,status:'RUNNING',consumer_retry_accepted:true};
      }
      if (status !== 'RUNNING') throw new Error('CUTOVER_MUTATION_RECOVERY_REQUIRED');
      const pause = request.action === 'pause-cutover-consumers';
      if (row.cutover_phase.S === (pause?'consumers-pausing':'consumers-resuming')) return {run_id:run,status:'RUNNING'};
      if (pause && row.cutover_phase.S === 'consumers-paused') return {run_id:run,status:'RUNNING',consumers_paused:true};
      if (!pause && row.cutover_phase.S === 'holding' && row.consumer_admission_restored?.BOOL === true) return {run_id:run,status:'RUNNING',consumers_restored:true};
      if (row.cutover_phase.S !== (pause?'holding':'consumers-paused')) throw new Error('INVALID_CONSUMER_CONTROL_PHASE');
      await replace(run,row,{...updated(row,pause?'consumers-pausing':'consumers-resuming'),consumer_action_id:{S:randomBytes(16).toString('hex')},consumer_admission_restored:{BOOL:false}},owner);
      return {run_id:run,status:'RUNNING'};
    }
    if (request.action === 'prepare-cutover-consumers') {
      if (status !== 'RUNNING' || owner?.execution_arn?.S !== arn || owner.kind?.S !== HOLD_KIND) throw new Error('CUTOVER_HOLD_OWNERSHIP_LOST');
      if (row.release_requested.BOOL || !['holding','consumer-preparing'].includes(row.cutover_phase.S)) throw new Error('CUTOVER_RECOVERY_REQUIRED');
      if (row.cutover_phase.S === 'consumer-preparing') return {run_id:run,status:'RUNNING'};
      if (consumerPlanPrepared(row)) return {run_id:run,status:'RUNNING',consumer_prepared:true};
      await replace(run,row,updated(row,'consumer-preparing'),owner);
      return {run_id:run,status:'RUNNING'};
    }
    if (request.action === 'release-cutover-hold') {
      if (row.cutover_phase.S !== 'holding' || row.database_mutations_started?.BOOL === true || row.consumer_admission_restored?.BOOL === false || row.deployment_admission_restored?.BOOL === false) throw new Error('CUTOVER_MUTATION_RECOVERY_REQUIRED');
      if (status === 'SUCCEEDED') {
        if (!row.release_requested.BOOL || owner?.execution_arn?.S === arn) throw new Error('CUTOVER_HOLD_OWNERSHIP_LOST');
        return {run_id:run,status:'SUCCEEDED'};
      }
      if (status !== 'RUNNING') throw new Error('CUTOVER_RECOVERY_REQUIRED');
      if (row.release_requested.BOOL) return {run_id:run,status:'RUNNING'};
      if (owner?.execution_arn?.S !== arn || owner.kind?.S !== HOLD_KIND) throw new Error('CUTOVER_HOLD_OWNERSHIP_LOST');
      await replace(run,row,{...updated(row,'holding'),release_requested:{BOOL:true}},owner);
      return {run_id:run,status:'RUNNING'};
    }
    if (request.action !== 'recover-cutover-hold') throw new Error('OPERATION_NOT_ALLOWED');
    if (!['holding','consumer-preparing','recovering'].includes(row.cutover_phase.S) || row.database_mutations_started?.BOOL === true || row.consumer_admission_restored?.BOOL === false || row.deployment_admission_restored?.BOOL === false) throw new Error('CUTOVER_MUTATION_RECOVERY_REQUIRED');
    if (!TERMINAL.has(status)) throw new Error('CUTOVER_HOLD_EXECUTION_STILL_RUNNING');
    if (['holding','consumer-preparing'].includes(row.cutover_phase.S)) {
      // Claim the phase before checking absence again. A delayed named start can
      // no longer advance from holding, even if its previous observation raced.
      const next = updated(row,'recovering');
      await replace(run,row,next,owner); row = next;
    }
    status = await describe(arn);
    if (!TERMINAL.has(status)) throw new Error('CUTOVER_HOLD_EXECUTION_STILL_RUNNING');
    await noActiveBuilds();
    owner = (await get('maintenance')).Item;
    const next = {...updated(row,'recovered'),cutover_execution_status:{S:status}};
    // Never delete or replace a different execution's maintenance record.
    await replace(run,row,next,owner,true);
    return {run_id:run,status:'RECOVERED',execution_status:status};
  };
}
module.exports = {createCutoverHoldControl,consumerPlanPrepared,definitionHash};
