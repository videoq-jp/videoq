const {execFileSync} = require('node:child_process');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const m = require('../../../.github/scripts/neon-admin.cjs');
const {safeError} = require('./policy.cjs');
const runId = process.env.MAINTENANCE_RUN_ID;
const table = process.env.MAINTENANCE_TABLE;
function assertBuildArn(arn) {
  if (!/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-(rotation|migration|backup|smoke|audit)-prod:[a-f0-9-]{36}$/.test(arn || '')) throw new Error('AWS_CODEBUILD_REQUIRED');
}
function key() {
  if (!/^[a-f0-9]{32}$/.test(runId || '') || table !== 'videoq-db-maintenance-prod') throw new Error('INVALID_AWS_JOB_CONTEXT');
  return {pk: {S: 'run#' + runId}};
}
function metadataValue(value) {
  const allowed = ['phase', 'generation', 'retire_after', 'rollback_after'];
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('UNSAFE_EXECUTION_METADATA');
  if (!['complete','promoted','retired','rollback_pending','rollback_retired'].includes(value.phase)) throw new Error('INVALID_EXECUTION_PHASE');
  if ((value.phase !== 'complete' || value.generation) && !/^\d{14}_[a-f0-9]{8}$/.test(value.generation || '')) throw new Error('INVALID_EXECUTION_GENERATION');
  const output = {...value};
  for (const field of ['retire_after','rollback_after']) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field]))) throw new Error('INVALID_EXECUTION_TIME');
      // Step Functions truncates timestamp milliseconds. Round UP to preserve grace.
      output[field] = new Date(Math.ceil(Date.parse(value[field])/1000)*1000).toISOString();
    }
  }
  if (value.phase === 'promoted' && !output.retire_after || value.phase === 'rollback_pending' && !output.rollback_after) throw new Error('MISSING_EXECUTION_GRACE');
  return output;
}
function metadata(value) {
  m.aws('dynamodb', 'update-item', {TableName: table, Key: key(), UpdateExpression: 'SET payload = :payload',
    ConditionExpression: 'attribute_exists(pk)', ReturnValues: 'UPDATED_NEW', ExpressionAttributeValues: {':payload': {S: JSON.stringify(metadataValue(value))}}});
}
function journal() {
  const value = m.readParameter(m.JOURNAL);
  const row = m.aws('dynamodb', 'get-item', {TableName: table, Key: key(), ConsistentRead: true}).Item;
  const expected = JSON.parse(row.payload.S);
  if (value.generation !== expected.generation) throw new Error('ROTATION_GENERATION_CHANGED');
  return value;
}
async function prepare() {
  if (process.env.MAINTENANCE_KIND === 'audit') {
    for (const profile of Object.values(m.PROFILES)) {
      const p = m.readParameter(profile.parameter);
      if (!Number.isFinite(Date.parse(p.created_at))) throw new Error('INVALID_CREDENTIAL_AGE');
    }
    metadata({phase: 'complete'}); return;
  }
  const current = m.readParameter(m.JOURNAL, true);
  let j;
  if (process.env.MAINTENANCE_KIND === 'rollback' || ['rollback_pending', 'rollback_retired'].includes(current?.phase)) j = await m.rollback(current);
  else {
    j = await m.prepare(process.env.MAINTENANCE_FORCE === 'true');
    if (!j) {metadata({phase: 'complete'}); return;}
    if (j.phase === 'prepared') j = await m.promote(j);
  }
  const value = {phase: j.phase, generation: j.generation};
  for (const name of ['retire_after', 'rollback_after']) if (j[name]) value[name] = j[name];
  metadata(value);
}
async function main() {
  key();
  assertBuildArn(process.env.CODEBUILD_BUILD_ARN);
  if (process.env.GITHUB_ACTIONS) throw new Error('GITHUB_MASK_COMMANDS_NOT_SUPPORTED_IN_AWS_LOGS');
  const stage = process.env.MAINTENANCE_STAGE;
  if (stage === 'prepare') return prepare();
  if (stage === 'retire') return m.retire(journal());
  if (stage === 'complete') return m.complete(journal());
  if (stage === 'retire-rollback') return m.finishRollback(journal());
  if (stage === 'complete-rollback') return m.completeRollback(journal());
  if (['backup', 'smoke', 'audit'].includes(stage)) {
    const script = {backup: 'backup-restore.mjs', smoke: 'production-smoke.mjs', audit: 'provision-public-demo.mjs'}[stage];
    execFileSync('python3', ['.github/scripts/with-neon-credentials.py', stage, 'node', '.github/scripts/' + script],
      {stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8*1024*1024, env: {...process.env, OPERATION: 'audit',
        GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'videoq-jp/videoq', VIDEOQ_BUNDLED_CHROMIUM: 'true'}});
    const report = stage === 'audit' ? null : JSON.parse(readFileSync('operations-report.json', 'utf8'));
    if (report && report.status !== 'ok') throw new Error('PRODUCTION_VERIFICATION_FAILED');
    console.log('Production verification succeeded: ' + stage); return;
  }
  if (stage === 'migration') {
    // The immutable operator bundle downloads only the requested canonical-main
    // source. The invoker cannot override a project, buildspec, role or command.
    const source = process.env.MAINTENANCE_SOURCE_SHA;
    if (!/^[a-f0-9]{40}$/.test(source || '')) throw new Error('INVALID_MIGRATION_SOURCE');
    execFileSync('python3', ['infra/db-maintenance/fetch_migration.py', source], {stdio: ['ignore','pipe','pipe'], maxBuffer: 8*1024*1024});
    const cwd = resolve('migration-source');
    execFileSync('npm', ['ci', '--ignore-scripts', '--prefix', '.github/deploy-tools'], {cwd, stdio: ['ignore','pipe','pipe'], maxBuffer: 8*1024*1024});
    execFileSync('npm', ['audit', 'signatures', '--prefix', '.github/deploy-tools'], {cwd, stdio: ['ignore','pipe','pipe'], maxBuffer: 8*1024*1024});
    execFileSync('ln', ['-s', '.github/deploy-tools/node_modules', 'node_modules'], {cwd, stdio: ['ignore','pipe','pipe']});
    execFileSync('python3', [resolve('.github/scripts/with-neon-credentials.py'), 'migration', 'sh', 'apps/api/scripts/db-migrate.sh'],
      {cwd, stdio: ['ignore','pipe','pipe'], maxBuffer: 8*1024*1024, env: {...process.env,
        STRUCTURED_ANSWER_WRITERS_STOPPED: process.env.MAINTENANCE_WRITERS_STOPPED === 'true' ? '1' : '0'}});
    console.log('Canonical-main database migration succeeded: ' + source); return;
  }
  throw new Error('UNKNOWN_AWS_JOB_STAGE');
}
if (require.main === module) main().catch(error => {console.error('AWS database job stopped: ' + safeError(error)); process.exitCode = 1;});
module.exports = {assertBuildArn, metadataValue, metadata, prepare, main};
