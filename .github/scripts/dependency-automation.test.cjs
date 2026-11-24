const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('./dependency-automation.cjs');

const REPOSITORY = 'videoq-jp/videoq';
const SHA = 'a'.repeat(40);
function pull() {
  return { number: 123, state: 'open', draft: false, user: { login: 'dependabot[bot]' }, labels: [],
    head: { ref: 'dependabot/npm_and_yarn/npm-patch-123', sha: SHA, repo: { full_name: REPOSITORY } },
    base: { ref: 'main', repo: { full_name: REPOSITORY } } };
}
const files = () => ['package.json', 'package-lock.json'].map(filename => ({ filename, status: 'modified' }));

test('only same-repository Dependabot manifest updates are eligible', () => {
  assert.equal(policy.eligiblePull(pull(), files(), 'no-automerge'), true);
  for (const change of [
    pr => { pr.state = 'closed'; }, pr => { pr.draft = true; },
    pr => { pr.user.login = 'someone'; }, pr => { pr.head.repo.full_name = 'fork/videoq'; },
    pr => { pr.base.ref = 'develop'; }, pr => { pr.head.ref = 'codex/repair'; },
    pr => { pr.head.sha = 'main'; }, pr => { pr.labels.push({ name: 'no-automerge' }); },
  ]) {
    const pr = pull(); change(pr);
    assert.equal(policy.eligiblePull(pr, files(), 'no-automerge'), false);
  }
  for (const filename of ['infra/main.tf', 'apps/web/src/index.ts']) {
    assert.equal(policy.eligiblePull(pull(), [...files(), { filename, status: 'modified' }], 'no-automerge'), false);
  }
  for (const status of ['added', 'removed', 'renamed']) {
    assert.equal(policy.eligiblePull(pull(), [{ filename: 'package.json', status }], 'no-automerge'), false);
  }
  assert.equal(policy.eligiblePull(pull(), [], 'no-automerge'), false);
});

test('opt-out labels independently control repair and merge', () => {
  const pr = pull(); pr.labels.push({ name: 'no-codex' });
  assert.equal(policy.eligiblePull(pr, files(), 'no-codex'), false);
  assert.equal(policy.eligiblePull(pr, files(), 'no-automerge'), true);
});

test('DB maintenance Terraform dependency files qualify without admitting resource changes', () => {
  const pr = pull();
  pr.head.ref = 'dependabot/terraform/infra/db-maintenance/terraform/terraform-minor-patch';
  const files = ['versions.tf', '.terraform.lock.hcl'].map(name => ({
    filename: `infra/db-maintenance/terraform/${name}`, status: 'modified',
  }));
  assert.equal(policy.eligiblePull(pr, files, 'no-automerge'), true);
  assert.equal(policy.eligiblePull(pr, [...files, {
    filename: 'infra/db-maintenance/terraform/main.tf', status: 'modified',
  }], 'no-automerge'), false);
});


test('historical automated repair notices do not veto newly verified automatic updates', () => {
  const notice = { user: { login: 'github-actions[bot]' }, body: '<!-- videoq-codex-repair-request -->' };
  assert.equal(policy.eligiblePull(pull(), files(), 'no-automerge', [notice]), true);
  assert.equal(policy.eligiblePull(pull(), files(), 'no-automerge', [{ ...notice, user: { login: 'someone' } }]), true);
});
