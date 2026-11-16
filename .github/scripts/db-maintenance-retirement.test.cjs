const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {definition} = require('../../infra/db-maintenance/state-machine.cjs');
test('retired production graph has only D1 jobs and rejects legacy operations', () => {
  const projects = {migration: 'migration', smoke: 'smoke', deploy: 'deploy'};
  const spec = definition({table:'maintenance', projects, neonRetired:true});
  assert.deepEqual(spec.States.Operation.Choices.map(choice=>choice.StringEquals), ['migration','d1-resource-hold','smoke','deploy']);
  assert.equal(spec.States[spec.States.Operation.Default].Type, 'Fail');
  assert.equal(spec.States.Deploy.Next, 'SmokeStandalone');
  assert.equal(spec.States.Release.Parameters.ConditionExpression, 'execution_arn = :execution');
  for (const state of Object.values(spec.States)) {
    if (state.Next) assert.ok(spec.States[state.Next]);
    if (state.Parameters?.ProjectName) assert.ok(Object.values(projects).includes(state.Parameters.ProjectName));
  }
  const template = JSON.parse(fs.readFileSync('infra/db-maintenance/state-machine.d1.asl.json.tftpl','utf8'));
  assert.deepEqual(template, definition({table:'${table}', projects:Object.fromEntries(Object.keys(projects).map(k=>[k,'${project_'+k+'}'])), neonRetired:true}));
});
