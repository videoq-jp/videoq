const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

// These integration controls use the real candidate and pinned old sources.
// Ordinary policy tests have no Python/npm fixture environment; the delivery
// job explicitly enables them after installing locked dependencies.
test('mixed release gate rejects corrupted hashes, invalid acceptance and repeated effects', {
  skip: process.env.RELEASE_COMPATIBILITY_NEGATIVE_CONTROLS !== '1', timeout: 120000,
}, () => {
  const root = path.resolve(__dirname, '../..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'videoq-compatibility-controls-'));
  try {
    execFileSync('git', ['init', '--quiet', temporary]);
    const objects = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: root, encoding: 'utf8' }).trim();
    fs.mkdirSync(path.join(temporary, '.git/objects/info'), { recursive: true });
    fs.writeFileSync(path.join(temporary, '.git/objects/info/alternates'), `${objects}\n`);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'HEAD', sha], { cwd: temporary });
    for (const file of ['apps/api/src/application', 'apps/api/src/lib/job-message.ts',
      'apps/worker/worker_python', 'packages/domain/test/fixtures', '.github/release-compatibility.json',
      '.github/scripts/release-compatibility.mjs', '.github/scripts/release-compatibility.py']) {
      fs.mkdirSync(path.dirname(path.join(temporary, file)), { recursive: true });
      fs.cpSync(path.join(root, file), path.join(temporary, file), { recursive: true });
    }
    const consumer = path.join(temporary, 'apps/api/src/application/background-job.ts');
    const original = fs.readFileSync(consumer, 'utf8');
    const loader = require.resolve('tsx/esm');
    for (const [name, before, after] of [
      ['wrong hash', 'await deps.sha256(canonicalBackgroundJob(job))', "'0'.repeat(64)"],
      ['completed replay', "if (claim.status === 'completed') return;", "if (claim.status === 'completed') { await deps.execute(job, 'replayed'); return; }"],
      ['invalid acceptance', 'throw new Error(\'Invalid or unsupported background job\');', "return value as BackgroundJob;"],
    ]) {
      assert.ok(original.includes(before), `Control no longer applies: ${name}`);
      fs.writeFileSync(consumer, original.replace(before, after));
      const result = spawnSync(process.execPath, ['--import', loader, '.github/scripts/release-compatibility.mjs'], {
        cwd: temporary, env: process.env, encoding: 'utf8', timeout: 30000,
      });
      assert.equal(result.error, undefined, name);
      assert.notEqual(result.status, 0, `Gate accepted ${name}`);
      const report = JSON.parse(fs.readFileSync(path.join(temporary, 'artifacts/release-compatibility.json'), 'utf8'));
      assert.equal(report.passed, false, name);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
