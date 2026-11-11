const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync, mkdtempSync, rmSync} = require('node:fs');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {spawnSync} = require('node:child_process');
const {runInNewContext} = require('node:vm');
const source = readFileSync(join(__dirname, '../workflows/onprem-validation.yml'), 'utf8');
function step(name) {
  const block = source.split(`      - name: ${name}\n`)[1];
  assert.ok(block, name);
  return block.split(/\n      - (?:name|uses|run):/)[0];
}
function enabled(name, lifecycle, upstream = false) {
  const condition = step(name).match(/^        if: (.+)$/m)?.[1] ?? 'true';
  return runInNewContext(condition.replace(/^\$\{\{ | \}\}$/g, ''), {
    inputs: {validate_lifecycle: lifecycle, scan_upstream_images: upstream},
    steps: {images: {outcome: 'success'}}, cancelled: () => false,
  });
}
const rehearsals = [
  'Validate the private Whisper API with locked dependencies',
  'Install pinned K3s operator tools',
  'Validate K3s backups, failed update recovery and uninstall',
  'Validate single-server restart and backup restore',
  'Install Chromium for single-server citation playback',
  'Validate single-server video, registry updates and failed migration recovery',
  'Install checksum-pinned kind',
  'Exercise Kubernetes install, processing, restore, upgrade and rollback',
];
test('image-only CI skips all inference-container and data-recovery rehearsals', () => {
  for (const name of rehearsals) {
    assert.equal(enabled(name, false), false, name);
    assert.equal(enabled(name, true), true, name);
  }
  assert.equal(enabled('Scan the local Whisper image including unfixed vulnerabilities', false), false);
  assert.equal(enabled('Resolve the pinned llama.cpp image', false), false);
  assert.equal(enabled('Resolve the pinned llama.cpp image', false, true), true);
});

test('both modes retain application images, runtime smoke checks and strict vulnerability scans', () => {
  for (const lifecycle of [false, true]) {
    for (const name of ['Build production on-prem images', 'Exercise production API image over HTTP',
      'Verify web image security headers and storage CSP',
      'Exercise migration command and worker imports in production images']) {
      assert.equal(enabled(name, lifecycle), true, name);
    }
    for (const component of ['API', 'worker', 'web']) {
      const name = `Scan the ${component} image including unfixed vulnerabilities`;
      assert.equal(enabled(name, lifecycle), true, name);
      assert.match(step(name), /severity: HIGH,CRITICAL/);
      assert.match(step(name), /ignore-unfixed: 'false'/);
      assert.match(step(name), /exit-code: '1'/);
    }
  }
});

test('reusable validation defaults to image checks and Operations explicitly skips lifecycle rehearsals', () => {
  assert.match(source, /validate_lifecycle:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/);
  const operations = readFileSync(join(__dirname, '../workflows/operations.yml'), 'utf8');
  assert.match(operations, /validate_lifecycle: false/);
  assert.doesNotMatch(operations, /validate_real_cpu:/);
  assert.match(operations, /uses: \.\/\.github\/workflows\/onprem-validation\.yml/);
});

test('inventories reference only images built in the selected mode', () => {
  const body = step('Record package inventories for incident response').split('        run: |\n')[1]
    .split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const directory = mkdtempSync(join(tmpdir(), 'onprem-inventory-'));
  try {
    for (const [lifecycle, upstream, expected] of [['false', 'false', 3], ['false', 'true', 4], ['true', 'false', 5]]) {
      const run = spawnSync('bash', ['-eu', '-c', 'trivy() { printf "%s\\n" "$*"; }\n' + body], {
        cwd: directory, encoding: 'utf8', env: {...process.env,
          VALIDATE_LIFECYCLE: lifecycle, SCAN_UPSTREAM_IMAGES: upstream, LLAMACPP_IMAGE: 'test-llama@sha256:123'},
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim().split('\n').length, expected);
      for (const component of ['api', 'worker', 'web']) assert.ok(run.stdout.includes(`videoq-${component}:onprem-ci`));
      assert.equal(run.stdout.includes('videoq-local-whisper:onprem-ci'), lifecycle === 'true');
      assert.equal(run.stdout.includes('test-llama@'), lifecycle === 'true' || upstream === 'true');
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
