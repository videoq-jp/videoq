const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const ci = readFileSync(join(__dirname, '../workflows/ci.yml'), 'utf8');
const onprem = readFileSync(join(__dirname, '../workflows/onprem-validation.yml'), 'utf8');
const gate = ci.match(/^  ci-success:\n([\s\S]*?)(?=^  [\w-]+:)/m)[1];
const dependencies = gate.match(/needs: \[([^\]]+)\]/)[1].split(',').map(name => name.trim());
const script = gate.match(/node <<'NODE'\n([\s\S]*?)^\s+NODE$/m)[1];

function result(selected, result, basicResult = 'success', inferenceSelected = selected) {
  const jobs = Object.fromEntries(dependencies.map(name => [name, { result: 'success' }]));
  jobs.changes.outputs = { onprem: String(selected), inference: String(inferenceSelected) };
  jobs['onprem-validation'].result = result;
  jobs['local-inference-basic'].result = basicResult;
  let exitCode = 0;
  runInNewContext(script, {
    process: { env: { JOB_RESULTS: JSON.stringify(jobs) }, exit(code) { exitCode = code; } },
    console: { error() {} },
  }, { timeout: 100 });
  return exitCode;
}

test('the existing required CI gate includes on-prem validation', () => {
  assert.ok(dependencies.includes('onprem-validation'));
  assert.match(ci, /onprem-validation:\n[\s\S]*?uses: \.\/\.github\/workflows\/onprem-validation\.yml/);
  assert.match(onprem, /workflow_call:/);
  for (const [name, patterns] of Object.entries({
    onprem_lifecycle: ['charts/**', 'scripts/onprem/**', 'apps/api/drizzle/**'],
    onprem: ['apps/web/Dockerfile*', 'apps/worker/uv.lock', 'package-lock.json', '.github/runtime-versions.json'],
  })) {
    const filter = ci.match(new RegExp(`^            ${name}:\\n([\\s\\S]*?)(?=^            \\w+:)`, 'm'))[1];
    for (const pattern of patterns) assert.ok(filter.includes(`'${pattern}'`), pattern);
  }
  assert.equal(result(true, 'success'), 0);
  assert.equal(result(false, 'skipped'), 0);
  for (const status of ['failure', 'cancelled', 'skipped']) {
    assert.equal(result(true, status), 1, status);
  }
});

test('all on-prem images are scanned without hiding unfixed findings', () => {
  const scans = onprem.split(/(?=      - name:)/).filter(step => step.includes('uses: aquasecurity/trivy-action@'));
  assert.equal(scans.length, 5);
  for (const scan of scans) assert.match(scan, /timeout-minutes: 15/);
  for (const component of ['api', 'worker', 'web', 'local-whisper']) {
    const scan = scans.find(step => step.includes(`image-ref: videoq-${component}:onprem-ci`));
    assert.ok(scan, component);
    assert.match(scan, /severity: HIGH,CRITICAL/);
    assert.match(scan, /ignore-unfixed: 'false'/);
    assert.match(scan, /exit-code: '1'/);
    assert.match(scan, /list-all-pkgs: 'true'/);
    assert.doesNotMatch(scan, /continue-on-error: true/);
  }
});

test('untrusted image builds have no production access and retain inventories', () => {
  assert.doesNotMatch(onprem, /secrets\.|secrets: inherit|environment:|id-token: write|packages: write|contents: write/);
  assert.match(onprem, /--format cyclonedx/);
  assert.match(onprem, /components=\(api worker web\)/);
  assert.match(onprem, /if-no-files-found: error/);
  for (const checkout of onprem.split(/(?=      - uses: actions\/checkout@)/).slice(1)) {
    assert.match(checkout, /persist-credentials: false/);
  }
});

test('the web build disables dependency lifecycle scripts', () => {
  const dockerfile = readFileSync(join(__dirname, '../../apps/web/Dockerfile'), 'utf8');
  const installs = dockerfile.match(/^RUN npm ci[^\n]*/gm);
  assert.ok(installs.length);
  for (const install of installs) assert.match(install, /--ignore-scripts/);
});


test('native basic checks are required when selected and use standard runners', () => {
  const basic = readFileSync(join(__dirname, '../workflows/local-inference-basic.yml'), 'utf8');
  assert.ok(dependencies.includes('local-inference-basic'));
  for (const status of ['failure', 'cancelled', 'skipped']) assert.equal(result(true, 'success', status), 1);
  assert.equal(result(false, 'skipped', 'skipped'), 0);
  assert.equal(result(true, 'success', 'skipped', false), 0);
  for (const status of ['failure', 'cancelled', 'skipped']) assert.equal(result(false, 'skipped', status, true), 1);
  for (const runner of ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15']) assert.ok(basic.includes(`runner: ${runner},`));
  assert.ok(basic.indexOf('brew update') < basic.indexOf('brew install --force-bottle'));
  assert.match(basic, /workflow_call:/);
  assert.doesNotMatch(basic, /workflow_dispatch:|schedule:/);
  const operations = readFileSync(join(__dirname, '../workflows/operations.yml'), 'utf8');
  assert.match(operations, /workflow_dispatch:/);
  assert.match(operations, /17 2 \* \* 1/);
  assert.match(operations, /uses: \.\/\.github\/workflows\/local-inference-basic.yml/);
  assert.match(basic, /uv sync --locked --extra dev/);
  assert.doesNotMatch(basic, /self-hosted|secrets\.|secrets: inherit|id-token: write|packages: write|--gpus|download-ggml/);
});


test('upstream CPU images retain separate architecture scans and a verified assessment', () => {
  const cpu = onprem.slice(onprem.indexOf('  upstream-cpu-images:'));
  assert.match(cpu, /engine: \[llamacpp, whispercpp\]/);
  assert.match(cpu, /architecture: \[amd64, arm64\]/);
  assert.match(cpu, /steps.header_inventory.outcome == 'success'/);
  assert.match(cpu, /apps\/inference\/whispercpp\/security\/header-image-inventory.json/);
  assert.match(cpu, /ignore-unfixed: 'false'/);
  assert.match(cpu, /exit-code: '0'/);
  assert.match(cpu, /onprem-upstream-security\.cjs upstream-cpu-security\.json/);
  assert.doesNotMatch(cpu, /continue-on-error: true/);
});

test('the on-prem component honors explicit GPU input while Operations preserves daily GPU checks', () => {
  assert.match(onprem, /if: inputs\.validate_whisper_gpu\n/);
  assert.doesNotMatch(onprem, /github\.event_name == 'schedule'/);
  const operations = readFileSync(join(__dirname, '../workflows/operations.yml'), 'utf8');
  assert.match(operations, /validate_whisper_gpu: \$\{\{ github\.event_name == 'schedule' \|\| inputs\.validate_whisper_gpu == true \}\}/);
});

test('CI scans pinned upstream images only when their pins change, while Operations always does', () => {
  assert.match(onprem, /scan_upstream_images:\n\s+type: boolean\n\s+default: true/);
  const cpu = onprem.slice(onprem.indexOf('  upstream-cpu-images:'));
  assert.match(cpu, /^    if: inputs\.scan_upstream_images$/m);
  assert.doesNotMatch(onprem, /LLAMACPP_IMAGE|llamacpp-security-raw/);
  assert.match(cpu, /trivy convert --format cyclonedx --output upstream-cpu.cdx.json upstream-cpu-security.json/);

  const filter = ci.match(/^            upstream_images:\n([\s\S]*?)(?=^            \w+:)/m)[1];
  for (const pattern of ['charts/videoq-inference/values.yaml', 'apps/inference/whispercpp/security/**',
    '.github/scripts/check-upstream-header-image.py']) {
    assert.ok(filter.includes(`'${pattern}'`), pattern);
  }
  assert.match(ci, /scan_upstream_images: \$\{\{ needs\.changes\.outputs\.upstream_images == 'true' \}\}/);
  const operations = readFileSync(join(__dirname, '../workflows/operations.yml'), 'utf8');
  assert.doesNotMatch(operations, /scan_upstream_images/);
});

test('normal on-prem validation reserves disk before building images or starting Kubernetes', () => {
  const steps = onprem.split(/(?=      - name:|      - uses:|      - run:)/);
  const reserve = steps.find(step => step.includes('name: Reserve disk for on-prem images and Kubernetes caches'));
  assert.ok(reserve);
  assert.doesNotMatch(reserve, /\bif:/);
  assert.match(reserve, /\/usr\/local\/lib\/android \/usr\/share\/dotnet \/opt\/ghc/);
  assert.ok(onprem.indexOf(reserve) < onprem.indexOf('      - uses: actions/setup-node@'));
});
