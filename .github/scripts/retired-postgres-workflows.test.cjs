const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readdirSync, readFileSync } = require('node:fs');

test('production workflow entry points cannot fetch retired PostgreSQL credentials or invoke cutover control', () => {
  for (const file of ['neon-bootstrap.yml', 'neon-credentials.yml', 'public-demo-setup.yml', 'd1-cutover-control.yml']) {
    assert.equal(existsSync(`.github/workflows/${file}`), false, file);
  }
  for (const file of readdirSync('.github/workflows').filter(file => /\.ya?ml$/.test(file))) {
    const source = readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.doesNotMatch(source, /^\s*(?:-\s*)?(?:uses:.*actions\/neon-credentials|run:.*(?:with-neon-credentials\.py|neon-bootstrap\.cjs|neon-maintenance-request\.cjs|cutover-maintenance-request\.cjs))/m, file);
  }
  assert.equal(existsSync('.github/actions/neon-credentials/action.yml'), false);
  // AWS still hosts current D1 migrations, smoke and reviewed recovery tooling.
  assert.ok(existsSync('.github/workflows/db-maintenance-cd.yml'));
  assert.match(readFileSync('.github/workflows/operations.yml', 'utf8'), /run-aws-db\.py smoke/);
});
