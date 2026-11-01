const {test} = require('node:test');
const assert = require('node:assert/strict');
const {relevant, selected} = require('./db-maintenance-cd.cjs');
test('deployment includes runtime, locked dependencies, operations fixtures and orchestration changes', () => {
  for (const path of ['infra/db-maintenance/runtime/broker.cjs','infra/db-maintenance/runtime/package-lock.json',
    'infra/db-maintenance/state-machine.cjs','.github/scripts/neon-admin.cjs',
    '.github/operations-tools/fixtures/smoke.mp4','apps/demo-video/public/lessons/math.mp4']) assert.equal(relevant(path),true,path);
  for (const path of ['apps/web/src/App.tsx','infra/db-maintenance/README.md','docs/guides/testing.md']) assert.equal(relevant(path),false,path);
});
test('compare from the last successful CD rather than a failed or superseded commit', async () => {
  const previous = 'a'.repeat(40), sha = 'b'.repeat(40);
  const github = {rest:{actions:{listWorkflowRuns:async()=>({data:{workflow_runs:[
    {id:3,conclusion:'failure',head_branch:'main',head_sha:'c'.repeat(40)},
    {id:2,conclusion:'success',head_branch:'main',head_sha:previous},
  ]}})}}};
  const git = args => {assert.deepEqual(args,['diff','--name-only',previous,sha]);return '.github/scripts/neon-admin.cjs\nREADME.md';};
  assert.equal(await selected({github,context:{repo:{},sha,runId:4},git}),true);
});
