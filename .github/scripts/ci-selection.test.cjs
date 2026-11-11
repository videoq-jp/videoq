const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, matchesGlob } = require('node:path');
const { runInNewContext } = require('node:vm');

const ci = readFileSync(join(__dirname, '../workflows/ci.yml'), 'utf8');
const expression = ci.match(/^      onprem: \$\{\{ (.+) \}\}$/m)[1];
function filter(name, paths) {
  const body = ci.match(new RegExp(`^            ${name}:\\n([\\s\\S]*?)(?=^            \\w+:)`, 'm'))[1];
  const patterns = [...body.matchAll(/- '([^']+)'/g)].map(match => match[1]);
  return String(paths.some(path => patterns.some(pattern => matchesGlob(path, pattern))));
}
function selected(event, paths = []) {
  return runInNewContext(expression, {
    github: { event_name: event },
    steps: { filter: { outputs: { onprem: filter('onprem', paths), onprem_pr: filter('onprem_pr', paths) } } },
  });
}

test('ordinary app PRs defer full platform integration to the merge queue and main', () => {
  for (const path of ['apps/web/src/pages/PricingPage.tsx', 'apps/api/src/features/chat/router.ts',
    'apps/worker/worker_python/transcription.py', 'packages/trpc/src/index.ts']) {
    assert.equal(selected('pull_request', [path]), false, path);
    for (const event of ['merge_group', 'push']) assert.equal(selected(event, [path]), true, `${event}: ${path}`);
  }
});

test('platform, runtime, dependency and migration changes still require integration in the PR', () => {
  for (const path of ['charts/videoq/values.yaml', 'scripts/onprem/install.sh', 'docker-compose.yml',
    'apps/api/Dockerfile', 'apps/api/src/runtime/node.ts', 'apps/api/drizzle/0001.sql',
    'apps/web/Dockerfile', 'apps/web/nginx.conf', 'apps/worker/Dockerfile.onprem',
    'apps/worker/uv.lock', 'apps/inference/whisper/server.py', '.dockerignore', 'package-lock.json',
    '.github/workflows/ci.yml', '.github/workflows/local-inference-basic.yml', '.node-version', '.python-version']) {
    for (const event of ['pull_request', 'merge_group', 'push']) assert.equal(selected(event, [path]), true, `${event}: ${path}`);
  }
  assert.equal(selected('pull_request', ['apps/web/src/App.tsx', 'charts/videoq/values.yaml']), true);
});

test('docs do not select platform integration; manual diagnostics always do', () => {
  for (const event of ['pull_request', 'merge_group', 'push']) {
    assert.equal(selected(event, ['docs/README.md']), false);
    assert.equal(selected(event), false);
  }
  assert.equal(selected('workflow_dispatch'), true);
  for (const id of ['onprem-validation', 'local-inference-basic']) {
    const job = ci.split(`\n  ${id}:\n`)[1].split(/\n  [a-z][\w-]*:\n/)[0];
    assert.match(job, /if: needs\.changes\.outputs\.onprem == 'true'/);
  }
});
