// Only metadata enters Step Functions history. Credentials stay inside scoped jobs.
function definition({table, projects}) {
  function job(project, stage, next, overrides = []) {
    return {Type: 'Task', Resource: 'arn:aws:states:::codebuild:startBuild.sync', Parameters: {
      ProjectName: projects[project], EnvironmentVariablesOverride: [
        {Name: 'MAINTENANCE_RUN_ID', 'Value.$': '$.run_id', Type: 'PLAINTEXT'},
        {Name: 'MAINTENANCE_STAGE', Value: stage, Type: 'PLAINTEXT'},
        {Name: 'MAINTENANCE_KIND', 'Value.$': '$.kind', Type: 'PLAINTEXT'},
        {Name: 'MAINTENANCE_FORCE', 'Value.$': "States.Format('{}', $.force)", Type: 'PLAINTEXT'},
        ...overrides,
      ]}, ResultPath: null, TimeoutSeconds: project === 'migration' ? 1200 : 2700, Next: next};
  }
  const variable = (Name, path) => ({Name, 'Value.$': path, Type: 'PLAINTEXT'});
  const states = {
    Operation: {Type: 'Choice', Choices: [
      {Variable: '$.kind', StringEquals: 'migration', Next: 'Migrate'},
      {Variable: '$.kind', StringEquals: 'backup', Next: 'BackupStandalone'},
      {Variable: '$.kind', StringEquals: 'smoke', Next: 'SmokeStandalone'},
    ], Default: 'Prepare'},
    Migrate: job('migration', 'migration', 'Release', [
      variable('MAINTENANCE_SOURCE_SHA', '$.source_sha'),
      variable('MAINTENANCE_WRITERS_STOPPED', "States.Format('{}', $.writers_stopped)"),
    ]),
    BackupStandalone: job('backup', 'backup', 'Release'),
    SmokeStandalone: job('smoke', 'smoke', 'Release', [variable('VERIFY_AI_ANSWERS', "States.Format('{}', $.verify_ai_answers)")]),
    Prepare: job('rotation', 'prepare', 'ReadMetadata'),
    ReadMetadata: {Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem', Parameters: {
      TableName: table, Key: {pk: {'S.$': "States.Format('run#{}', $.run_id)"}}, ConsistentRead: true,
      ProjectionExpression: 'payload',
    }, ResultSelector: {'payload.$': 'States.StringToJson($.Item.payload.S)'}, ResultPath: '$.decision', Next: 'Phase'},
    Phase: {Type: 'Choice', Choices: [
      {Variable: '$.decision.payload.phase', StringEquals: 'complete', Next: 'Release'},
      {Variable: '$.decision.payload.phase', StringEquals: 'promoted', Next: 'SmokeBeforeRetirement'},
      {Variable: '$.decision.payload.phase', StringEquals: 'retired', Next: 'SmokeAfterRetirement'},
      {Variable: '$.decision.payload.phase', StringEquals: 'rollback_pending', Next: 'SmokeBeforeRollbackRetirement'},
      {Variable: '$.decision.payload.phase', StringEquals: 'rollback_retired', Next: 'SmokeAfterRollbackRetirement'},
    ], Default: 'InvalidPhase'},
    SmokeBeforeRetirement: job('smoke', 'smoke', 'BackupBeforeRetirement'),
    BackupBeforeRetirement: job('backup', 'backup', 'AuditBeforeRetirement'),
    AuditBeforeRetirement: job('audit', 'audit', 'WaitForInvocations'),
    WaitForInvocations: {Type: 'Wait', TimestampPath: '$.decision.payload.retire_after', Next: 'Retire'},
    Retire: job('rotation', 'retire', 'SmokeAfterRetirement'),
    SmokeAfterRetirement: job('smoke', 'smoke', 'Complete'),
    Complete: job('rotation', 'complete', 'Release'),
    SmokeBeforeRollbackRetirement: job('smoke', 'smoke', 'WaitForRollbackInvocations'),
    WaitForRollbackInvocations: {Type: 'Wait', TimestampPath: '$.decision.payload.rollback_after', Next: 'RetireRollback'},
    RetireRollback: job('rotation', 'retire-rollback', 'SmokeAfterRollbackRetirement'),
    SmokeAfterRollbackRetirement: job('smoke', 'smoke', 'CompleteRollback'),
    CompleteRollback: job('rotation', 'complete-rollback', 'Release'),
    Release: {Type: 'Task', Resource: 'arn:aws:states:::dynamodb:deleteItem', Parameters: {
      TableName: table, Key: {pk: {S: 'maintenance'}}, ConditionExpression: 'execution_arn = :execution',
      ExpressionAttributeValues: {':execution': {'S.$': '$$.Execution.Id'}},
    }, ResultPath: null, Next: 'Success'},
    Success: {Type: 'Succeed'},
    InvalidPhase: {Type: 'Fail', Error: 'INVALID_DATABASE_MAINTENANCE_PHASE'},
  };
  // Do not retry credential mutations blindly. Existing journal phases provide
  // deliberate resume/rollback, and a failure retains the global rotation lock.
  return {Comment: 'AWS-only Neon maintenance; no credential material in execution data', StartAt: 'Operation', TimeoutSeconds: 7200, States: states};
}
module.exports = {definition};
if (require.main === module) console.log(JSON.stringify(definition({table: '${table}', projects: Object.fromEntries(['rotation','migration','backup','smoke','audit'].map(k => [k, '${project_' + k + '}']))}), null, 2));
