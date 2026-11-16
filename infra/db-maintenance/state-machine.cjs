// Only metadata enters Step Functions history. Credentials stay inside scoped jobs.
function definition({table, projects, neonRetired = false}) {
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
      {And: [{Variable:'$.kind',StringEquals:'audit'}, {Variable:'$.inspection',IsPresent:true}, {Variable:'$.inspection',StringEquals:'postgres-login-fence'}], Next:'LoginFenceAudit'},
      {Variable: '$.kind', StringEquals: 'cutover-hold', Next: 'ReadCutoverHold'},
      {Variable: '$.kind', StringEquals: 'migration', Next: 'Migrate'},
      {Variable: '$.kind', StringEquals: 'backup', Next: 'BackupStandalone'},
      {Variable: '$.kind', StringEquals: 'smoke', Next: 'SmokeStandalone'},
      {Variable: '$.kind', StringEquals: 'deploy', Next: 'Deploy'},
    ], Default: 'Prepare'},
    ReadCutoverHold: {Type:'Task',Resource:'arn:aws:states:::dynamodb:getItem',Parameters:{
      TableName:table,Key:{pk:{'S.$':"States.Format('run#{}', $.run_id)"}},ConsistentRead:true,
      ProjectionExpression:'cutover_phase,release_requested,consumer_action_id,activity_action_id',
    },ResultPath:'$.hold',Next:'CutoverHoldPhase'},
    CutoverHoldPhase: {Type:'Choice',Choices:[
      {And:[{Variable:'$.hold.Item.cutover_phase.S',StringEquals:'postwrite-complete'},{Variable:'$.hold.Item.release_requested.BOOL',BooleanEquals:true}],Next:'ReleasePostwriteHold'},
      {And:[{Variable:'$.hold.Item.cutover_phase.S',StringEquals:'activity-auditing'},{Variable:'$.hold.Item.release_requested.BOOL',BooleanEquals:false}],Next:'InspectCutoverActivity'},
      {And:[{Variable:'$.hold.Item.cutover_phase.S',StringEquals:'consumers-pausing'}, {Variable:'$.hold.Item.release_requested.BOOL',BooleanEquals:false}],Next:'PauseCutoverConsumers'},
      {And:[{Variable:'$.hold.Item.cutover_phase.S',StringEquals:'consumers-resuming'}, {Variable:'$.hold.Item.release_requested.BOOL',BooleanEquals:false}],Next:'ResumeCutoverConsumers'},
      {And:[{Variable:'$.hold.Item.cutover_phase.S',StringEquals:'consumers-paused'}, {Variable:'$.hold.Item.release_requested.BOOL',BooleanEquals:false}],Next:'WaitCutoverHold'},
      {And:[{Variable:'$.hold.Item.cutover_phase.S',StringEquals:'consumer-preparing'},
        {Variable:'$.hold.Item.release_requested.BOOL',BooleanEquals:false}],Next:'PrepareCutoverConsumers'},
      {And:[{Variable:'$.hold.Item.cutover_phase.S',StringEquals:'holding'},
        {Variable:'$.hold.Item.release_requested.BOOL',BooleanEquals:true}],Next:'ReleaseCutoverHold'},
      {And:[{Variable:'$.hold.Item.cutover_phase.S',StringEquals:'holding'},
        {Variable:'$.hold.Item.release_requested.BOOL',BooleanEquals:false}],Next:'WaitCutoverHold'},
    ],Default:'InvalidCutoverHoldPhase'},
    InspectCutoverActivity: job('rotation','cutover-activity-audit','ReadCutoverHold',[variable('MAINTENANCE_SOURCE_SHA','$.source_sha'),variable('MAINTENANCE_ACTIVITY_ACTION_ID','$.hold.Item.activity_action_id.S')]),
    PauseCutoverConsumers: job('rotation', 'cutover-consumer-pause', 'ReadCutoverHold', [variable('MAINTENANCE_SOURCE_SHA', '$.source_sha'),variable('MAINTENANCE_CONSUMER_ACTION_ID','$.hold.Item.consumer_action_id.S')]),
    ResumeCutoverConsumers: job('rotation', 'cutover-consumer-resume', 'ReadCutoverHold', [variable('MAINTENANCE_SOURCE_SHA', '$.source_sha'),variable('MAINTENANCE_CONSUMER_ACTION_ID','$.hold.Item.consumer_action_id.S')]),
    PrepareCutoverConsumers: job('rotation', 'cutover-consumer-prepare', 'ReadCutoverHold', [variable('MAINTENANCE_SOURCE_SHA', '$.source_sha')]),
    WaitCutoverHold: {Type:'Wait',Seconds:10,Next:'ReadCutoverHold'},
    ReleaseCutoverHold: {Type:'Task',Resource:'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',Parameters:{TransactItems:[
      {ConditionCheck:{TableName:table,Key:{pk:{'S.$':"States.Format('run#{}', $.run_id)"}},
        ConditionExpression:'#phase = :phase AND release_requested = :requested AND database_mutations_started = :false AND (attribute_not_exists(postgres_fence_state) OR postgres_fence_state = :fenceReleased) AND (attribute_not_exists(consumer_admission_restored) OR consumer_admission_restored = :requested) AND (attribute_not_exists(deployment_admission_restored) OR deployment_admission_restored = :requested) AND (attribute_not_exists(api_admission_restored) OR api_admission_restored = :requested)',
        ExpressionAttributeNames:{'#phase':'cutover_phase'},ExpressionAttributeValues:{':phase':{S:'holding'},':fenceReleased':{S:'released'},':requested':{Bool:true},':false':{Bool:false}}}},
      {Delete:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution',
        ExpressionAttributeValues:{':execution':{'S.$':'$$.Execution.Id'}}}},
    ]},ResultPath:null,Next:'Success'},
    // Only the trusted finalizer can publish this phase after real D1 E2E and
    // restored admission. Never reuse the prewrite path or reset its marker.
    ReleasePostwriteHold: {Type:'Task',Resource:'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',Parameters:{TransactItems:[
      {ConditionCheck:{TableName:table,Key:{pk:{'S.$':"States.Format('run#{}', $.run_id)"}},
        ConditionExpression:'execution_arn = :execution AND source_sha = :source AND cutover_phase = :phase AND release_requested = :true AND database_mutations_started = :true AND postgres_fence_state = :fenced AND api_admission_restored = :true AND consumer_admission_restored = :true AND deployment_admission_restored = :true AND api_pause_verified = :false AND attribute_exists(postwrite_completion_receipt) AND attribute_exists(postwrite_completion_receipt_sha256) AND attribute_exists(d1_e2e_receipt) AND attribute_exists(d1_e2e_receipt_sha256)',
        ExpressionAttributeValues:{':execution':{'S.$':'$$.Execution.Id'},':source':{'S.$':'$.source_sha'},':phase':{S:'postwrite-complete'},':fenced':{S:'fenced'},':true':{Bool:true},':false':{Bool:false}}}},
      {Delete:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'execution_arn = :execution AND #kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':execution':{'S.$':'$$.Execution.Id'},':kind':{S:'cutover-hold'}}}},
    ]},ResultPath:null,Next:'Success'},
    InvalidCutoverHoldPhase: {Type:'Fail',Error:'INVALID_CUTOVER_HOLD_PHASE'},
    LoginFenceAudit: job('rotation', 'login-fence-audit', 'Release'),
    Migrate: job('migration', 'migration', 'Release', [
      variable('MAINTENANCE_SOURCE_SHA', '$.source_sha'),
      variable('MAINTENANCE_WRITERS_STOPPED', "States.Format('{}', $.writers_stopped)"),
    ]),
    BackupStandalone: job('backup', 'backup', 'Release'),
    SmokeStandalone: job('smoke', 'smoke', 'Release', [variable('VERIFY_AI_ANSWERS', "States.Format('{}', $.verify_ai_answers)")]),
    Deploy: job('deploy', 'deploy', 'SmokeStandalone', [variable('MAINTENANCE_SOURCE_SHA', '$.source_sha')]),
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
  if (neonRetired) {
    const keep = ['Operation', 'Migrate', 'SmokeStandalone', 'Deploy', 'Release', 'Success'];
    const active = Object.fromEntries(keep.map(name => [name, states[name]]));
    active.Operation = {Type: 'Choice', Choices: states.Operation.Choices.filter(choice =>
      ['migration', 'smoke', 'deploy'].includes(choice.StringEquals)), Default: 'RetiredOperation'};
    active.RetiredOperation = {Type: 'Fail', Error: 'RETIRED_NEON_OPERATION'};
    return {Comment: 'AWS-only D1 maintenance; retained archives are outside the job lifecycle',
      StartAt: 'Operation', TimeoutSeconds: 7200, States: active};
  }
  // Do not retry credential mutations blindly. Existing journal phases provide
  // deliberate resume/rollback, and a failure retains the global rotation lock.
  return {Comment: 'AWS-only Neon maintenance; no credential material in execution data', StartAt: 'Operation', TimeoutSeconds: 7200, States: states};
}
module.exports = {definition};
if (require.main === module) {
  const production = process.argv.includes('--production');
  console.log(JSON.stringify(definition({neonRetired: process.argv.includes('--d1-only'), table: production ? 'videoq-db-maintenance-prod' : '${table}',
    projects: Object.fromEntries(['rotation','migration','backup','smoke','audit','deploy'].map(k => [k, production ? `videoq-db-${k}-prod` : '${project_' + k + '}']))}), null, 2));
}
