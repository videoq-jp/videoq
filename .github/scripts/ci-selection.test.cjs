const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, matchesGlob } = require('node:path');
const { runInNewContext } = require('node:vm');

const ci = readFileSync(join(__dirname, '../workflows/ci.yml'), 'utf8');
function filter(name, paths) {
  const body = ci.match(new RegExp(`^            ${name}:\\n([\\s\\S]*?)(?=^            \\w+:)`, 'm'))[1];
  const patterns = [...body.matchAll(/- '([^']+)'/g)].map(match => match[1]);
  return String(paths.some(path => patterns.some(pattern => matchesGlob(path, pattern))));
}
function selected(name, event, paths = []) {
  const expression = ci.match(new RegExp(`^      ${name}: \\$\\{\\{ (.+) \\}\\}$`, 'm'))[1];
  const names = ['onprem', 'onprem_lifecycle', 'inference', 'whisper_gpu', 'upstream_images', 'real_cpu', 'moodle'];
  const value = runInNewContext(expression, {
    github: { event_name: event },
    steps: { filter: { outputs: Object.fromEntries(names.map(name => [name, filter(name, paths)])) } },
  });
  return value === true || value === 'true';
}
const events = ['pull_request', 'merge_group', 'push'];

test('app, docs and CI metadata edits do not trigger full on-prem or native inference on any event', () => {
  for (const path of ['apps/web/src/pages/PricingPage.tsx', 'apps/api/src/features/chat/router.ts',
    'apps/worker/worker_python/lambda_handler.py', 'packages/trpc/src/index.ts', 'docs/README.md',
    '.github/workflows/ci.yml', '.github/WORKFLOWS.md', '.github/scripts/audit-signatures.cjs']) {
    for (const event of events) {
      for (const name of ['onprem', 'onprem_lifecycle', 'inference', 'whisper_gpu', 'moodle']) {
        assert.equal(selected(name, event, [path]), false, `${event}/${name}: ${path}`);
      }
    }
  }
});

test('dependency and production image updates retain image checks without data recovery rehearsals', () => {
  for (const path of ['package-lock.json', 'package.json', 'apps/api/package.json', 'apps/web/package.json',
    'apps/api/Dockerfile', 'apps/web/Dockerfile', 'apps/web/nginx.conf', 'apps/worker/Dockerfile.onprem',
    'apps/worker/uv.lock', '.dockerignore', '.node-version', '.python-version', '.github/runtime-versions.json']) {
    for (const event of events) {
      assert.equal(selected('onprem', event, [path]), true, `${event}: ${path}`);
      assert.equal(selected('onprem_lifecycle', event, [path]), false, `${event}: ${path}`);
      assert.equal(selected('whisper_gpu', event, [path]), false, `${event}: ${path}`);
    }
  }
  for (const event of events) assert.equal(selected('inference', event, ['package-lock.json']), false);
});

test('installer, deployment, database and storage changes retain full lifecycle validation', () => {
  for (const path of ['charts/videoq/values.yaml', 'scripts/onprem/k3s.py', 'docker-compose.yml',
    'infra/garage/config.toml', 'apps/api/src/runtime/node.ts', 'apps/api/drizzle/0001.sql',
    'apps/api/src/db/schema/modern.ts', 'apps/api/scripts/db-migrate.sh', 'apps/api/src/integrations/media.ts',
    'apps/worker/worker_python/pipeline/storage.py', '.github/scripts/onprem-lab.py',
    '.github/workflows/onprem-validation.yml']) {
    for (const event of events) {
      assert.equal(selected('onprem', event, [path]), true, `${event}: ${path}`);
      assert.equal(selected('onprem_lifecycle', event, [path]), true, `${event}: ${path}`);
    }
  }
  assert.equal(selected('onprem_lifecycle', 'merge_group', ['apps/web/src/App.tsx', 'charts/videoq/values.yaml']), true);
});

test('native and GPU checks are selected independently from lifecycle recovery', () => {
  for (const path of ['apps/inference/whisper/server.py', 'charts/videoq-inference/values.yaml',
    '.github/inference-basic-packages.json', '.github/workflows/local-inference-basic.yml',
    'apps/api/src/lib/chat-model.ts', 'apps/worker/worker_python/pipeline/embeddings.py']) {
    for (const event of events) assert.equal(selected('inference', event, [path]), true, `${event}: ${path}`);
  }
  for (const event of events) {
    assert.equal(selected('onprem_lifecycle', event, ['apps/inference/whisper/server.py']), false);
    assert.equal(selected('whisper_gpu', event, ['apps/inference/whisper/Dockerfile.vllm']), true);
    assert.equal(selected('onprem', event, ['apps/inference/whisper/Dockerfile.vllm']), true);
  }
});

test('manual CI uses lifecycle change selection and both components remain required when selected', () => {
  for (const name of ['onprem', 'inference']) {
    assert.equal(selected(name, 'workflow_dispatch'), true);
    for (const event of events) assert.equal(selected(name, event), false);
  }
  assert.equal(selected('onprem_lifecycle', 'workflow_dispatch'), false);
  assert.equal(selected('onprem_lifecycle', 'workflow_dispatch', ['scripts/onprem/k3s.py']), true);
  for (const [id, flag] of [['onprem-validation', 'onprem'], ['local-inference-basic', 'inference']]) {
    const job = ci.split(`\n  ${id}:\n`)[1].split(/\n  [a-z][\w-]*:\n/)[0];
    assert.ok(job.includes(`if: needs.changes.outputs.${flag} == 'true'`));
  }
  assert.match(ci, /validate_lifecycle: \$\{\{ needs\.changes\.outputs\.onprem_lifecycle == 'true' \}\}/);
});

test('shared workflow edits do not download models or scan unchanged upstream image matrices', () => {
  for (const event of events) {
    for (const name of ['whisper_gpu', 'real_cpu', 'upstream_images']) {
      assert.equal(selected(name, event, ['.github/workflows/ci.yml']), false, name);
      assert.equal(selected(name, event, ['.github/workflows/onprem-validation.yml']), false, name);
    }
    assert.equal(selected('real_cpu', event, ['.github/scripts/onprem-cpu-acceptance.py']), true);
    assert.equal(selected('upstream_images', event, ['charts/videoq-inference/values.yaml']), true);
    assert.equal(selected('whisper_gpu', event, ['apps/inference/whisper/Dockerfile.vllm']), true);
  }
});

test('Moodle integration still runs for its fixture, workflow and contract changes', () => {
  for (const event of events) {
    for (const path of ['.github/moodle-cpu/Dockerfile', '.github/workflows/moodle-installed.yml',
      '.github/scripts/moodle-installed-acceptance.py', '.github/onprem-lab/dependencies.json']) {
      assert.equal(selected('moodle', event, [path]), true, `${event}: ${path}`);
    }
  }
});
