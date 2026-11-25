/** Run real producer/consumer source from pinned deployed and candidate revisions. */
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [output = 'artifacts/release-compatibility.json'] = process.argv.slice(2);
const pin = JSON.parse(await readFile('.github/release-compatibility.json', 'utf8'));
for (const sha of [pin.apiSource, pin.apiDeployedSource, pin.pythonSource]) assert.match(sha, /^[a-f0-9]{40}$/);
const snapshot = await mkdtemp(resolve(tmpdir(), 'videoq-compatibility-'));
async function extract(sha, role) {
  const root = resolve(snapshot, role); await mkdir(root);
  execFileSync('tar', ['-x', '-C', root], { input: execFileSync('git', ['archive', sha,
    'apps/api/src/application', 'apps/api/src/lib/job-message.ts', 'apps/worker/worker_python',
    'packages/domain/test/fixtures/background-jobs.json'], { maxBuffer: 16 * 1024 * 1024 }) });
  return root;
}
const oldRoot = await extract(pin.apiSource, 'api');
const deployedApi = await extract(pin.apiDeployedSource, 'api-deployed');
const oldPython = await extract(pin.pythonSource, 'python');
const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const versions = { old: resolve(oldRoot), deployed: deployedApi, new: process.cwd() };
const pythonVersions = { old: oldPython, new: process.cwd() };
const report = { candidate, deployed: pin, passed: false, combinations: [] };
await mkdir(resolve(output, '..'), { recursive: true });
try {
  // Run each revision's own vectors in addition to candidate vectors. Old vectors
  // must not silently change when the candidate updates its shared fixtures.
  for (const [producerVersion, producerRoot] of Object.entries({ 'api-old': oldRoot, 'api-deployed': deployedApi, 'api-new': versions.new, 'python-old': oldPython, 'python-new': versions.new })) {
    let emitted;
    if (producerVersion.startsWith('python')) {
      emitted = JSON.parse(execFileSync(process.env.COMPATIBILITY_PYTHON ?? 'python3',
        ['.github/scripts/release-compatibility.py', producerRoot, '--produce'], { encoding: 'utf8' }));
    } else {
      const vectors = JSON.parse(await readFile(resolve(producerRoot, 'packages/domain/test/fixtures/background-jobs.json'), 'utf8'));
      const { buildJobMessage } = await import(pathToFileURL(resolve(producerRoot, 'apps/api/src/lib/job-message.ts')));
      emitted = vectors.map(vector => ({ ...vector, message: vector.accepted
        ? buildJobMessage(vector.message.type, vector.message.payload, vector.message.job_id) : vector.message }));
    }
    assert.ok(emitted.length >= 58, `Producer fixture coverage shrank: ${producerVersion}`);
    const wire = `${output}.${producerVersion}-wire.json`;
    await writeFile(wire, JSON.stringify(emitted));
    for (const [consumerVersion, consumerRoot] of Object.entries(versions)) {
      const { executeBackgroundJob, canonicalBackgroundJob, parseBackgroundJob } = await import(pathToFileURL(resolve(consumerRoot, 'apps/api/src/application/background-job.ts')));
      for (const vector of emitted) {
        let effects = 0, claims = 0, completed = false;
        const deps = {
          repository: {
            claim: async identity => { claims++; assert.equal(identity.payloadSha256, vector.sha256); return completed ? { status: 'completed' } : { status: 'claimed', leaseToken: 'synthetic-lease' }; },
            complete: async () => { completed = true; return true; },
            fail: async () => { throw new Error('Unexpected failed delivery'); }, heartbeat: async () => true,
          },
          sha256: async text => createHash('sha256').update(text).digest('hex'),
          execute: async () => { effects++; },
        };
        if (!vector.accepted) {
          await assert.rejects(() => executeBackgroundJob(vector.message, deps)); assert.equal(claims, 0);
        } else {
          assert.equal(canonicalBackgroundJob(parseBackgroundJob(vector.message)), vector.canonical);
          await executeBackgroundJob(vector.message, deps);
          await executeBackgroundJob(vector.message, deps);
          assert.equal(claims, 2); assert.equal(effects, 1); assert.equal(completed, true);
        }
      }
      report.combinations.push({ producer: producerVersion, consumer: `api-${consumerVersion}`, cases: emitted.length, passed: true });
    }
    for (const [consumerVersion, consumerRoot] of Object.entries(pythonVersions)) {
      // Python consumers use the selected revision's execution entry point and
      // canonical hash, in a separate process to prevent module-cache shadowing.
      const result = JSON.parse(execFileSync(process.env.COMPATIBILITY_PYTHON ?? 'python3',
        ['.github/scripts/release-compatibility.py', consumerRoot, wire], { encoding: 'utf8' }));
      report.combinations.push({ producer: producerVersion, consumer: `python-${consumerVersion}`, ...result });
    }
  }
  assert.equal(report.combinations.length, 25);
  assert.equal(new Set(report.combinations.map(row => row.producer + ':' + row.consumer)).size, 25);
  report.passed = true;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await rm(snapshot, { recursive: true, force: true });
}
