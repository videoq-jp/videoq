const ACCOUNT = '257240362763';
const REGION = 'ap-northeast-1';
const REPOSITORY = 'videoq-jp/videoq';
const KINDS = Object.freeze(['rotate', 'rollback', 'audit', 'migration', 'backup', 'smoke']);
function input(event, allowedKinds) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('INVALID_REQUEST');
  const permitted = event.action === 'status' ? ['action', 'run_id'] : ['action', 'kind', 'force', 'source_sha', 'writers_stopped', 'verify_ai_answers', 'client_token'];
  if (Object.keys(event).some(key => !permitted.includes(key))) throw new Error('UNEXPECTED_INPUT');
  if (event.action === 'status') {
    if (!/^[a-f0-9]{32}$/.test(event.run_id || '')) throw new Error('INVALID_RUN_ID');
    return {action: 'status', run_id: event.run_id};
  }
  if (event.action !== 'start' || !KINDS.includes(event.kind) || !allowedKinds.includes(event.kind)) throw new Error('OPERATION_NOT_ALLOWED');
  if (event.force !== undefined && (typeof event.force !== 'boolean' || event.kind !== 'rotate')) throw new Error('INVALID_FORCE');
  if (event.kind === 'migration') {
    if (!/^[a-f0-9]{40}$/.test(event.source_sha || '') || typeof event.writers_stopped !== 'boolean') throw new Error('INVALID_MIGRATION_SOURCE');
  } else if (event.source_sha !== undefined || event.writers_stopped !== undefined) throw new Error('UNEXPECTED_SOURCE');
  if (event.verify_ai_answers !== undefined && (event.kind !== 'smoke' || typeof event.verify_ai_answers !== 'boolean')) throw new Error('INVALID_SMOKE_OPTION');
  if (event.client_token !== undefined && !/^[a-f0-9]{32}$/.test(event.client_token)) throw new Error('INVALID_CLIENT_TOKEN');
  return {action: 'start', kind: event.kind, force: event.force === true,
    ...(event.kind === 'migration' ? {source_sha: event.source_sha, writers_stopped: event.writers_stopped} : {}),
    ...(event.kind === 'smoke' ? {verify_ai_answers: event.verify_ai_answers === true} : {}),
    ...(event.client_token ? {client_token: event.client_token} : {})};
}
function executionArn(machine, name) {
  if (!new RegExp(`^arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:videoq-db-maintenance-prod$`).test(machine)) throw new Error('UNEXPECTED_STATE_MACHINE');
  if (!/^db-[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_EXECUTION_NAME');
  return machine.replace(':stateMachine:', ':execution:') + ':' + name;
}
function safeError(error) {
  return /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'MAINTENANCE_REQUEST_FAILED';
}
module.exports = {ACCOUNT, REGION, REPOSITORY, KINDS, input, executionArn, safeError};
