const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');

// Execute the actual CD shell with inert stand-ins, including fail-fast behavior.
const workflow = readFileSync('.github/workflows/cd.yml', 'utf8');
const run = workflow.split('      - name: Push prebuilt image and update Lambda\n')[1]
  .split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
function deploy(fail = '') {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
    docker() { :; }
    aws() {
      printf '%s\\n' "$*"
      if [ "$2" = "update-function-code" ] && [ "$4" = "$FAIL_FUNCTION" ]; then return 1; fi
      return 0
    }
    ${run}
  `], {encoding: 'utf8', env: {
    ...process.env, SOURCE_SHA: 'test-sha', IMAGE_REPOSITORY: 'example/worker',
    FUNCTION_NAME: 'videoq-worker-prod', FAIL_FUNCTION: fail,
  }});
}
test('CD deploys and waits for search/account before media with one immutable image', () => {
  const result = deploy();
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 6);
  for (const [index, name] of ['videoq-worker-search-prod', 'videoq-worker-account-prod', 'videoq-worker-prod'].entries()) {
    assert.equal(lines[index * 2], `lambda update-function-code --function-name ${name} --image-uri example/worker:test-sha`);
    assert.equal(lines[index * 2 + 1], `lambda wait function-updated --function-name ${name}`);
  }
});
test('failed search deployment stops rollout before account/media are updated', () => {
  const result = deploy('videoq-worker-search-prod');
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split('\n').length, 1);
});
