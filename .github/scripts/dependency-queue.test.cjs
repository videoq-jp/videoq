const { test } = require('node:test');
const assert = require('node:assert/strict');
const q = require('./dependency-queue.cjs');
function pull(login = 'dependabot[bot]', ref = 'dependabot/npm_and_yarn/patch') {
  return { base: { ref: 'main' }, user: { login }, head: { ref, sha: 'a'.repeat(40), repo: { full_name: 'videoq-jp/videoq' } } };
}
test('managed scope excludes development and forks; both runtime channels can receive repairs', () => {
  assert.equal(q.managed(pull()), true);
  assert.equal(q.managed(pull('developer')), false);
  const fork = pull(); fork.head.repo.full_name = 'fork/videoq'; assert.equal(q.managed(fork), false);
  assert.equal(q.managed(pull('videoq-dependency-bot[bot]', 'runtime/python-next')), true);
  assert.equal(q.managed(pull('videoq-dependency-bot[bot]', 'runtime/python-current')), true);
});
test('all real validation workflows must complete; skipped or missing evidence cannot authorize a queue entry', () => {
  assert.equal(q.result([]), 'waiting');
  const success = { admitted: true, run: { status: 'completed', conclusion: 'success' } };
  assert.equal(q.result([success, success, success]), 'success');
  for (const row of [{}, { ...success, admitted: false }, { admitted: true, run: { status: 'in_progress' } }]) {
    assert.equal(q.result([success, row, success]), 'waiting');
  }
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required']) {
    assert.equal(q.result([success, { admitted: true, run: { status: 'completed', conclusion } }, success]), 'failure');
  }
});
test('one CI run must contain every real required check before queue admission', async () => {
  let jobs = ['CI Success', 'Supply Chain Security', 'Container Validation', 'Terraform Plan'].map(name => ({ name, conclusion: 'success' }));
  const calls = [];
  const github = { rest: { actions: {
    listWorkflowRuns: async ({ workflow_id }) => { calls.push(workflow_id); return { data: { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] } }; },
    listJobsForWorkflowRun: async () => jobs,
  } }, paginate: (method, args) => method(args) };
  const args = { github, context: { repo: { owner: 'videoq-jp', repo: 'videoq' } }, pr: pull() };
  assert.equal(q.result(await q.runs(args)), 'success');
  assert.deepEqual(calls, ['ci.yml']);
  for (const required of [...jobs]) {
    const original = jobs;
    jobs = original.filter(job => job.name !== required.name);
    assert.equal(q.result(await q.runs(args)), 'waiting');
    jobs = original.map(job => job.name === required.name ? { ...job, conclusion: 'skipped' } : job);
    assert.equal(q.result(await q.runs(args)), 'waiting');
    jobs = original;
  }
});
