const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const workflow = readFileSync(join(__dirname, '../workflows/cd.yml'), 'utf8');
function job(name) {
  const body = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))?.[1];
  assert.ok(body, `Missing job ${name}`);
  return {
    body,
    dependencies: body.match(/^    needs: \[([^\]]+)\]/m)?.[1].split(',').map(value => value.trim()),
    condition: body.match(/^    if: \|\n((?:      .+\n)+)/m)?.[1].trim(),
  };
}

function canDeploy(jobName, outputs, results = {}) {
  const needs = {
    changes: { result: 'success', outputs: { api: 'true', web: 'true', worker: 'true', migrate: 'true', ...outputs } },
    'db-migrate': { result: 'success' },
    'worker-build': { result: 'success' },
    'application-build': { result: 'success' },
    'api-deploy': { result: 'success' },
    'web-deploy': { result: 'success' },
  };
  for (const [name, result] of Object.entries(results)) needs[name].result = result;
  const expression = job(jobName).condition.replace(
    /needs\.([\w-]+)\.(?:outputs\.([\w]+)|(result))/g,
    (_, name, output) => JSON.stringify(output ? needs[name].outputs[output] : needs[name].result),
  );
  return runInNewContext(expression, { always: () => true }, { timeout: 100 });
}

const workerCanDeploy = (outputs, results) => canDeploy('worker-deploy', outputs, results);

test('every CD checkout uses a GitHub-provided immutable SHA', () => {
  const refs = [...workflow.matchAll(/^\s+ref: (.+)$/gm)].map(match => match[1]);
  assert.ok(refs.length >= 7);
  for (const ref of refs) {
    assert.ok(['${{ github.sha }}', '${{ github.workflow_sha }}'].includes(ref), ref);
  }
});

test('database migrations run once before API deployment', () => {
  assert.equal(workflow.includes('db-finalize:'), false);
  assert.equal(workflow.includes('MIGRATION_PHASE:'), false);
  assert.ok(job('api-deploy').dependencies.includes('db-migrate'));
});

test('the deployment graph schedules shared-data readers before the worker', () => {
  assert.ok(job('api-deploy').dependencies.includes('db-migrate'));
  assert.ok(job('web-deploy').dependencies.includes('api-deploy'));
  for (const dependency of ['changes', 'db-migrate', 'api-deploy', 'web-deploy']) {
    assert.ok(job('worker-deploy').dependencies.includes(dependency), `Worker must wait for ${dependency}`);
  }
});


test('coordinated deployment proceeds after migration and both readers succeed', () => {
  assert.equal(workerCanDeploy({}), true);
  assert.equal(workerCanDeploy({}, { 'db-migrate': 'skipped' }), false);
  assert.equal(workerCanDeploy({ migrate: 'false' }, { 'db-migrate': 'skipped' }), true);
});

for (const dependency of ['changes', 'worker-build', 'db-migrate', 'api-deploy', 'web-deploy']) {
  for (const result of ['failure', 'cancelled']) {
    test(`blocks the worker when ${dependency} reports ${result}`, () => {
      assert.equal(workerCanDeploy({}, { [dependency]: result }), false);
    });
  }
}
for (const dependency of ['api-deploy', 'web-deploy']) {
  test(`blocks the worker when selected ${dependency} was unexpectedly skipped`, () => {
    assert.equal(workerCanDeploy({}, { [dependency]: 'skipped' }), false);
  });
}
test('worker-only changes allow unchanged readers to be skipped', () => {
  assert.equal(workerCanDeploy({ api: 'false', web: 'false', migrate: 'false' }, {
    'db-migrate': 'skipped', 'api-deploy': 'skipped', 'web-deploy': 'skipped',
  }), true);
});
test('a deployment waits for whichever reader changed', () => {
  assert.equal(workerCanDeploy({ web: 'false' }, { 'web-deploy': 'skipped' }), true);
  assert.equal(workerCanDeploy({ api: 'false' }, { 'api-deploy': 'skipped' }), true);
});
test('does not deploy the worker when its files did not change', () => {
  assert.equal(workerCanDeploy({ worker: 'false' }), false);
});


test('application builds cannot access production secrets or an OIDC token', () => {
  for (const name of ['application-build', 'worker-build']) {
    const body = job(name).body;
    assert.doesNotMatch(body, /environment:|secrets\.|id-token: write|contents: write/);
  }
});
test('Cloudflare uploads never install application dependencies or build application code', () => {
  for (const name of ['api-deploy', 'web-deploy', 'docs-deploy']) {
    const body = job(name).body;
    assert.match(body, /needs: \[changes, application-build/);
    assert.match(body, /--no-bundle --no-autoconfig --env-file \/dev\/null/);
    assert.match(body, /deployment-config\.cjs/);
    assert.doesNotMatch(body, /npm run|npm ci(?! --ignore-scripts --prefix \.github\/deploy-tools)|docker build/);
  }
});
test('AWS upload job does not execute the built image or project code', () => {
  const body = job('worker-deploy').body;
  assert.match(body, /docker load/);
  assert.match(body, /docker push/);
  assert.doesNotMatch(body, /actions\/checkout|docker (?:build|run)|npm |pip install/);
  assert.equal(workerCanDeploy({}, { 'worker-build': 'skipped' }), false);
});

// GitHub emits workflow_run for failed/cancelled CI as well as successful CI.
// Skip them before starting CD; keep validate-deployment.cjs as defence in depth.
test('CD starts only for successful main push CI or an explicit manual dispatch', () => {
  const expression = job('changes').body.match(/^    if: (.+)$/m)?.[1];
  assert.ok(expression);
  const allowed = (eventName, event, conclusion, repository = 'videoq-jp/videoq', ref = 'refs/heads/main') =>
    runInNewContext(expression, { github: { repository, ref, event_name: eventName,
      event: { workflow_run: { event, conclusion } } } }, { timeout: 100 });
  assert.equal(allowed('workflow_run', 'push', 'success'), true);
  assert.equal(allowed('workflow_dispatch'), true);
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', undefined]) {
    assert.equal(allowed('workflow_run', 'push', conclusion), false, String(conclusion));
  }
  for (const event of ['pull_request', 'merge_group', 'workflow_dispatch']) {
    assert.equal(allowed('workflow_run', event, 'success'), false, event);
  }
  assert.equal(allowed('workflow_run', 'push', 'success', 'fork/videoq'), false);
  assert.equal(allowed('workflow_dispatch', undefined, undefined, 'videoq-jp/videoq', 'refs/heads/feature'), false);
});
