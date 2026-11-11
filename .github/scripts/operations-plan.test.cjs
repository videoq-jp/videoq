const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('./operations-plan.cjs');
const context = { repo: { owner: 'videoq-jp', repo: 'videoq' }, ref: 'refs/heads/main', eventName: 'schedule', payload: { schedule: '17 0 * * *' } };
const selected = result => Object.keys(result).filter(key => result[key]);
test('daily monitoring excludes the monthly database restore', async () => {
  assert.deepEqual(selected(await plan({ context })), ['dependencies', 'containers', 'terraform', 'tokens', 'smoke', 'onprem']);
  assert.deepEqual(selected(await plan({ context: { ...context, payload: { schedule: '41 4 1 * *' } } })), ['backup']);
});
test('configuration pushes run only the credential-free token monitor', async () => {
  assert.deepEqual(selected(await plan({ context: { ...context, eventName: 'push' } })), ['tokens']);
});
test('manual selection runs one check or all checks including backup', async () => {
  const manual = { ...context, eventName: 'workflow_dispatch' };
  assert.deepEqual(selected(await plan({ context: manual, check: 'tokens' })), ['tokens']);
  assert.equal(selected(await plan({ context: manual })).length, 8);
  await assert.rejects(plan({ context: manual, check: 'arbitrary' }));
});
function cd() {
  const run = { id: 1, workflow_id: 7, head_branch: 'main', conclusion: 'success',
    repository: { full_name: 'videoq-jp/videoq' }, head_repository: { full_name: 'videoq-jp/videoq' } };
  return { context: { ...context, eventName: 'workflow_run', payload: { workflow_run: run } },
    github: { rest: { actions: { getWorkflow: async () => ({ data: { id: 7 } }),
      listWorkflowRuns: async () => ({ data: { workflow_runs: [{ id: 1 }] } }),
      listJobsForWorkflowRun: async () => ({data:{jobs:[{name:'Deploy web (prebuilt Cloudflare artifact)',conclusion:'success'}]}}),
    } } } };
}
test('docs-only and no-op deployments do not repeat application smoke', async () => {
  const f = cd();
  const names = ['Deploy web (prebuilt Cloudflare artifact)', 'Deploy api (prebuilt Cloudflare artifact)',
    'Deploy prebuilt Worker Lambda image', 'Drizzle DB Migrate'];
  const jobs = names.map(name => ({name, conclusion:'skipped'}));
  jobs.push({name:'Deploy docs (prebuilt Cloudflare artifact)',conclusion:'success'});
  f.github.rest.actions.listJobsForWorkflowRun = async () => ({data:{jobs}});
  assert.deepEqual(selected(await plan(f)), []);
  for (const name of names) {
    jobs.find(job => job.name === name).conclusion = 'success';
    assert.deepEqual(selected(await plan(f)), ['smoke']);
    jobs.find(job => job.name === name).conclusion = 'skipped';
  }
  jobs.splice(0,1);
  assert.deepEqual(selected(await plan(f)), ['smoke']); // Unknown layout never skips verification.
});
test('only the latest successful canonical CD starts the production smoke check', async () => {
  const f = cd();
  assert.deepEqual(selected(await plan(f)), ['smoke']);
  f.github.rest.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: [{ id: 2 }] } });
  assert.deepEqual(selected(await plan(f)), []);
});
for (const [name, change] of [
  ['fork', f => { f.context.payload.workflow_run.head_repository.full_name = 'fork/videoq'; }],
  ['another repo', f => { f.context.payload.workflow_run.repository.full_name = 'other/videoq'; }],
  ['untrusted workflow', f => { f.context.payload.workflow_run.workflow_id = 8; }],
  ['failed CD', f => { f.context.payload.workflow_run.conclusion = 'failure'; }],
  ['another branch', f => { f.context.payload.workflow_run.head_branch = 'feature'; }],
  ['non-main ref', f => { f.context.ref = 'refs/heads/feature'; }],
]) test('rejects '+name+' before authorizing production monitoring', async () => {
  const f = cd(); change(f); await assert.rejects(plan(f));
});
test('PR and unknown scheduled events cannot start production checks', async () => {
  await assert.rejects(plan({ context: { ...context, eventName: 'pull_request' } }));
  await assert.rejects(plan({ context: { ...context, payload: { schedule: '* * * * *' } } }));
});

test('weekly inference compatibility keeps its schedule separate from the daily lifecycle rehearsal', async () => {
  assert.deepEqual(selected(await plan({ context: { ...context, payload: { schedule: '17 2 * * 1' } } })), ['inference']);
});
