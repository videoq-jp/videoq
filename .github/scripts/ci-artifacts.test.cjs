const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const workflow = name => readFileSync(join(__dirname, '../workflows', name + '.yml'), 'utf8');
const ci = workflow('ci');
function evaluate(expression, eventName, changed = false, overrides = {}) {
  return runInNewContext(expression, {
    github: { event_name: eventName, repository: 'videoq-jp/videoq', ref: 'refs/heads/main', event: { workflow_run: { event: 'push' } }, ...overrides },
    steps: { filter: { outputs: { frontend: String(changed), docs: String(changed) } } },
  }, { timeout: 100 });
}

test('manual diagnostic CI builds frontend and docs even with no matching changes', () => {
  assert.match(ci, /^  workflow_dispatch:/m);
  for (const name of ['frontend', 'docs']) {
    const expression = ci.match(new RegExp(`^      ${name}: \\$\\{\\{ (.+) \\}\\}$`, 'm'))[1];
    assert.equal(evaluate(expression, 'workflow_dispatch'), true);
    for (const event of ['push', 'pull_request']) {
      assert.equal(evaluate(expression, event), false);
      assert.equal(evaluate(expression, event, true), true);
    }
  }
});

test('diagnostic artifacts are opt-in while coverage remains available to its consumer', () => {
  for (const name of ['frontend-build', 'frontend-storybook', 'documentation-build']) {
    const step = [...ci.matchAll(/      - [\s\S]*?(?=^      - |^  [\w-]+:|$(?![\s\S]))/gm)].map(m => m[0]).find(s => s.includes(`name: ${name}\n`));
    assert.ok(step, name);
    const condition = step.match(/^        if: (.+)$/m)[1];
    assert.equal(evaluate(condition, 'workflow_dispatch'), true);
    assert.equal(evaluate(condition, 'push'), false);
    assert.equal(evaluate(condition, 'pull_request'), false);
  }
  const coverage = ci.match(/      - name: Save frontend coverage\n([\s\S]*?)(?=^  frontend-coverage:)/m)[1];
  assert.doesNotMatch(coverage, /if:/);
  assert.match(ci, /name: Download frontend coverage[\s\S]*?name: frontend-coverage/);
});

test('manual CI completion cannot trigger production or on-prem deployment', () => {
  for (const name of ['cd', 'onprem-release']) {
    const condition = workflow(name).match(/^    if: (.+)$/m)[1];
    assert.equal(evaluate(condition, 'workflow_run'), true);
    assert.equal(evaluate(condition, 'workflow_dispatch'), true);
    assert.equal(evaluate(condition, 'workflow_run', false, { event: { workflow_run: { event: 'workflow_dispatch' } } }), false);
    assert.equal(evaluate(condition, 'workflow_run', false, { repository: 'someone/videoq' }), false);
    assert.equal(evaluate(condition, 'workflow_dispatch', false, { ref: 'refs/heads/feature' }), false);
  }
});


test('manual supply-chain checks resolve the default branch to a full SHA and retain the online gate', () => {
  const job=ci.slice(ci.indexOf('  supply-chain:'),ci.indexOf('  workflow-security:'));
  assert.match(job,/EVENT_NAME: \$\{\{ github.event_name \}\}/);
  assert.match(job,/if \[ "\$EVENT_NAME" = workflow_dispatch \]; then/);
  assert.match(job,/git rev-parse --verify "refs\/remotes\/origin\/\$DEFAULT_BRANCH\^\{commit\}"/);
  assert.match(job,/python .github\/scripts\/supply-chain.py --base "\$base"/);
  assert.doesNotMatch(job,/--offline/);
});
