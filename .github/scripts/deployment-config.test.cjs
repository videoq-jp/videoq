const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, symlinkSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { deploymentConfig, rejectSymlinks } = require('./deployment-config.cjs');

test('production bindings survive while build hooks and arbitrary entrypoints do not', () => {
  const result = deploymentConfig({
    name: 'videoq-api-dev', main: '/tmp/attacker.js', build: { command: 'steal-token' },
    containers: [{ image: 'attacker' }], compatibility_date: '2026-08-20',
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Example'] }],
    env: { production: { name: 'videoq-api', vars: { ENVIRONMENT: 'production' },
      hyperdrive: [{ binding: 'HYPERDRIVE', id: 'trusted' }], build: { command: 'evil' } } },
  }, 'api', '/artifacts');
  assert.equal(result.main, '/artifacts/api/worker/index.js');
  assert.equal(result.no_bundle, true);
  assert.equal(result.vars.ENVIRONMENT, 'production');
  assert.equal(result.hyperdrive[0].id, 'trusted');
  assert.equal(result.migrations[0].tag, 'v1');
  assert.equal(result.build, undefined);
  assert.equal(result.containers, undefined);
  assert.equal(result.env, undefined);
});

test('static assets cannot redirect the deployment tool outside the artifact', () => {
  const result = deploymentConfig({ name: 'videoq-docs', assets: { directory: '/etc', html_handling: 'force-trailing-slash' } }, 'docs', '/artifacts');
  assert.equal(result.assets.directory, '/artifacts/docs/assets');
  assert.equal(result.assets.html_handling, 'force-trailing-slash');
  assert.equal(result.main, undefined);
  assert.throws(() => deploymentConfig({ name: 'another-account' }, 'docs', '/artifacts'));
});

test('web uploads include the hashed Text module imported by the prebuilt Worker', () => {
  const result = deploymentConfig({ name: 'videoq-web', env: { production: { name: 'videoq-web' } } }, 'web', '/artifacts');
  assert.ok(result.rules.some(rule => rule.type === 'Text' && rule.globs.includes('**/*-_headers')));
  assert.equal(result.preserve_file_names, true);
});

test('symlinked artifacts fail before credentials are used', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deployment-config-'));
  try {
    symlinkSync('/etc', join(directory, 'escape'));
    assert.throws(() => rejectSymlinks(directory), /symlink rejected/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('D1 cutover upload carries the exact production database and both vector indexes', () => {
  const production = {
    name: 'videoq-api', vars: { ENVIRONMENT: 'production', DEPLOYMENT_EDITION: 'cloud', PERSISTENCE_BACKEND: 'd1', MIGRATION_TRAFFIC_STATE: 'paused' },
    d1_databases: [{ binding: 'DB', database_name: 'production-copy', database_id: '11111111-2222-4333-8444-555555555555', migrations_dir: 'drizzle-d1' }],
    vectorize: [{ binding: 'SCENE_VECTORIZE_1536', index_name: 'production-1536' }, { binding: 'SCENE_VECTORIZE_768', index_name: 'production-768' }],
  };
  const result = deploymentConfig({ name: 'videoq-api-dev', env: { production } }, 'api', '/artifacts');
  assert.deepEqual(result.d1_databases, production.d1_databases);
  assert.deepEqual(result.vectorize, production.vectorize);
  assert.equal(result.vars.MIGRATION_TRAFFIC_STATE, 'paused');
  assert.equal(result.vars.PERSISTENCE_BACKEND, 'd1');
  assert.equal(result.hyperdrive, undefined);
});

test('omitted production bindings do not inherit development data stores or variables', () => {
  const original = { name: 'videoq-api-dev', vars: { ENVIRONMENT: 'development' },
    d1_databases: [{ binding: 'DB', database_id: 'development' }], vectorize: [{ binding: 'SCENE_VECTORIZE_1536', index_name: 'development' }],
    hyperdrive: [{ binding: 'HYPERDRIVE', id: 'development' }], r2_buckets: [{ binding: 'VIDEO_BUCKET', bucket_name: 'development' }],
    durable_objects: { bindings: [{ name: 'TASK_SCHEDULER', class_name: 'DevOnly' }] }, ai: { binding: 'DEV_AI' },
    env: { production: { name: 'videoq-api' } } };
  const result = deploymentConfig(original, 'api', '/artifacts');
  for (const key of ['vars', 'd1_databases', 'vectorize', 'hyperdrive', 'r2_buckets', 'durable_objects', 'ai']) assert.equal(result[key], undefined);
});

test('the production API exposes the signed worker persistence path through its narrowly scoped route', () => {
  const source = require('node:fs').readFileSync('apps/api/wrangler.jsonc', 'utf8');
  const production = source.slice(source.indexOf('"production": {'));
  const routes = production.match(/"routes"\s*:\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(routes);
  assert.match(routes, /"pattern"\s*:\s*"videoq\.jp\/internal\/worker\/\*"/);
  assert.doesNotMatch(routes, /"pattern"\s*:\s*"videoq\.jp\/internal\/\*"/);
  assert.match(production, /"workers_dev"\s*:\s*false/);
  const expected = [{ pattern: 'videoq.jp/internal/worker/*', zone_name: 'videoq.jp' }];
  const result = deploymentConfig({ env: { production: { name: 'videoq-api', routes: expected, workers_dev: false } } }, 'api', '/artifacts');
  assert.deepEqual(result.routes, expected);
  assert.equal(result.workers_dev, false);
});


test('approved production AI binding survives the upload-only configuration', () => {
  const source = require('node:fs').readFileSync('apps/api/wrangler.jsonc', 'utf8');
  const production = source.slice(source.indexOf('"production": {'));
  const ai = JSON.parse(production.match(/"ai"\s*:\s*(\{[^}]+\})/)?.[1] ?? 'null');
  const vars = Object.fromEntries(['LLM_PROVIDER', 'LLM_MODEL'].map(key =>
    [key, production.match(new RegExp('"'+key+'"\\s*:\\s*"([^"\\n]+)"'))?.[1]]));
  const result = deploymentConfig({ env: { production: { name: 'videoq-api', ai, vars } } }, 'api', '/artifacts');
  assert.deepEqual(result.ai, { binding: 'AI' });
  assert.equal(result.vars.LLM_PROVIDER, 'workers-ai');
  assert.equal(result.vars.LLM_MODEL, '@cf/google/gemma-4-26b-a4b-it');
});
