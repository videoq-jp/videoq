const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identity, preflight } = require('./embedding-release-preflight.cjs');
const target = { vars: { EMBEDDING_MODEL: 'same-model', EMBEDDING_REVISION: 'weights-1' }, d1_databases: [{ binding: 'DB', database_id: '11111111-2222-4333-8444-555555555555' }] };
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-test' };
const response = rows => Response.json({ success: true, result: [{ success: true, results: rows }] });
const valid = { incompatible_runs: 0, incompatible_scenes: 0, incompatible_writes: 0 };
test('release identity matches the TS/Python golden vector and tracks same-dimension replacement', () => {
  assert.equal(identity(target.vars).fingerprint, '72c3a9b62f132cd1730ade65f15d69e79d91c1122c97650bfceaa79f99ee439d');
  for (const endpoint of ['EMBEDDING_BASE_URL', 'OPENAI_BASE_URL']) assert.throws(() => identity({ ...target.vars, [endpoint]: 'https://private.example/v1' }), /INVALID_EMBEDDING_RELEASE_CONFIG/);
  for (const change of [{ EMBEDDING_REVISION: 'weights-2' }, { EMBEDDING_PREPROCESSING: 'normalize-v2' }, { EMBEDDING_MODEL: 'different' }]) assert.notEqual(identity({ ...target.vars, ...change }).fingerprint, identity(target.vars).fingerprint);
});
test('strict release is read-only, exact-target scoped, bounded and fail closed', async () => {
  let calls = 0;
  const result = await preflight(target, env, async (url, options) => {
    calls++;
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${target.d1_databases[0].database_id}/query`);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.ok(body.sql.startsWith('WITH')); assert.doesNotMatch(body.sql, /\b(?:UPDATE|INSERT|DELETE|ALTER)\b/);
    assert.deepEqual(body.params, [1536, identity(target.vars).fingerprint]);
    return response([valid]);
  });
  assert.equal(calls, 1); assert.equal(result.serving, true);
  for (const key of Object.keys(valid)) await assert.rejects(preflight(target, env, async () => response([{ ...valid, [key]: 1 }])), /REBUILD_REQUIRED/);
  for (const bad of [() => new Response('', { status: 403 }), () => Response.json({ success: false }), () => response([]), () => response([{ ...valid, incompatible_runs: null }]), () => new Response('x'.repeat(65537))]) await assert.rejects(preflight(target, env, async () => bad()), /UNAVAILABLE/);
});
test('paused candidate never authorizes serving, and explicit resume rechecks provenance', async () => {
  const paused = { ...target, vars: { ...target.vars, MIGRATION_TRAFFIC_STATE: 'paused' } };
  assert.equal((await preflight(paused, env, () => { throw Error('no query needed for non-serving candidate'); })).serving, false);
  await assert.rejects(preflight(paused, env, async () => response([{ ...valid, incompatible_scenes: 1 }]), { resume: true }), /REBUILD_REQUIRED/);
  assert.equal((await preflight(paused, env, async () => response([valid]), { resume: true })).serving, true);
  await assert.rejects(preflight({ ...target, vars: { ...target.vars, MIGRATION_TRAFFIC_STATE: 'typo' } }, env), /TRAFFIC_STATE/);
});
test('file data cannot select the credential destination or inject a resource path', async () => {
  const never = () => { throw Error('unexpected network request'); };
  for (const id of ['https://evil.example', '../other', target.d1_databases[0].database_id + '?redirect=https://evil.example', target.d1_databases[0].database_id + '\n', 123, null]) {
    await assert.rejects(preflight({ ...target, d1_databases: [{ binding: 'DB', database_id: id }] }, env, never), /UNAVAILABLE/);
  }
  for (const account of ['https://evil.example', 'a'.repeat(32) + '/../../', 'a'.repeat(32) + '\n', 123, null]) {
    await assert.rejects(preflight(target, { ...env, CLOUDFLARE_ACCOUNT_ID: account }, never), /UNAVAILABLE/);
  }
  for (const token of ['', 'token\r\nHost: evil.example', 'token with spaces', 123, null]) {
    await assert.rejects(preflight(target, { ...env, CLOUDFLARE_API_TOKEN: token }, never), /UNAVAILABLE/);
  }
  const file = JSON.parse(JSON.stringify({ ...target, url: 'https://evil.example', CLOUDFLARE_API_TOKEN: 'file-token', vars: {
    ...target.vars, EMBEDDING_BASE_URL: 'https://evil.example/private-secret', EMBEDDING_PREPROCESSING: 'raw-text-v1',
  } }));
  await preflight(file, env, async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.cloudflare.com');
    assert.equal(parsed.pathname, `/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${target.d1_databases[0].database_id}/query`);
    assert.equal(options.headers.authorization, 'Bearer synthetic-test');
    assert.equal(options.redirect, 'error');
    assert.doesNotMatch(options.body, /evil|private-secret|file-token|synthetic-test/);
    assert.deepEqual(JSON.parse(options.body).params, [1536, identity(file.vars).fingerprint]);
    return response([valid]);
  });
});
