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

function result(selected, result, basicResult = 'success') {
  const jobs = Object.fromEntries(dependencies.map(name => [name, { result: 'success' }]));
  jobs.changes.outputs = { onprem: String(selected) };
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
  for (const pattern of ['charts/**', 'apps/web/**', 'apps/worker/**', 'package-lock.json', '.github/runtime-versions.json', '.github/scripts/check-upstream-header-image.py']) {
    const filter = ci.match(/^            onprem:\n([\s\S]*?)(?=^            \w+:)/m)[1];
    assert.ok(filter.includes(`'${pattern}'`), pattern);
  }
  assert.equal(result(true, 'success'), 0);
  assert.equal(result(false, 'skipped'), 0);
  for (const status of ['failure', 'cancelled', 'skipped']) {
    assert.equal(result(true, status), 1, status);
  }
});

test('all on-prem images are scanned without hiding unfixed findings', () => {
  const scans = onprem.split(/(?=      - name:)/).filter(step => step.includes('uses: aquasecurity/trivy-action@'));
  assert.equal(scans.length, 7);
  for (const component of ['api', 'worker', 'web', 'local-whisper', 'upstream_cpu', 'vllm']) {
    const scan = scans.find(step => step.includes(['upstream_cpu', 'vllm'].includes(component)
      ? 'image-ref: ${{ env.' + component.toUpperCase() + '_IMAGE }}' : `image-ref: videoq-${component}:onprem-ci`));
    assert.ok(scan, component);
    assert.match(scan, /severity: HIGH,CRITICAL/);
    assert.match(scan, /ignore-unfixed: 'false'/);
    assert.match(scan, /exit-code: '1'/);
    assert.doesNotMatch(scan, /continue-on-error: true/);
  }
});

test('untrusted image builds have no production access and retain inventories', () => {
  assert.doesNotMatch(onprem, /secrets\.|secrets: inherit|environment:|id-token: write|packages: write|contents: write/);
  assert.match(onprem, /--format cyclonedx/);
  assert.match(onprem, /for component in api worker web/);
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

test('vLLM validation pulls the upstream image and checks the actual WAV input path', () => {
  const gpu = onprem.slice(onprem.indexOf('  vllm-image:'));
  assert.match(gpu, /docker pull "\$VLLM_IMAGE"/);
  assert.match(gpu, /--network none.*check_runtime.py/);
  assert.doesNotMatch(gpu, /docker build|pip install/);
  assert.match(gpu, /uv sync --locked --no-dev --no-install-package torch/);
  assert.match(gpu, /provision_audio.py/);
  const filter = ci.match(/^            whisper_gpu:\n([\s\S]*?)(?=^            \w+:)/m)[1];
  for (const file of ['provision_audio.py', 'pyproject.toml', 'uv.lock', 'Dockerfile', '.python-version']) {
    assert.ok(filter.includes(`apps/inference/whisper/${file}`));
  }
});

test('upstream GPU checks cover both vendors without applying NVIDIA assessments to AMD', () => {
  const gpu = onprem.slice(onprem.indexOf('  vllm-image:'));
  // Default/CI matrix semantics are executed in vllm-candidate.test.cjs.
  assert.match(gpu, /fromJSON\('\["nvidia","amd"\]'\)/);
  assert.match(gpu, /vllm.rocmImage : vllm.image/);
  assert.match(gpu, /trivy-config: \$\{\{ matrix.accelerator == 'nvidia'/);
  assert.match(gpu, /name: vllm-security-\$\{\{ matrix.accelerator \}\}/);
});


test('CPU upstream validation scans each engine and architecture independently', () => {
  const cpu = onprem.slice(onprem.indexOf('  upstream-cpu-images:'));
  assert.match(cpu, /engine: \[llamacpp, whispercpp\]/);
  assert.match(cpu, /architecture: \[amd64, arm64\]/);
  assert.match(cpu, /fail-fast: false/);
  assert.match(cpu, /values\.whispercpp\.images\[process\.env\.ARCHITECTURE\]/);
  assert.match(cpu, /TRIVY_PLATFORM: linux\/\$\{\{ matrix\.architecture \}\}/);
  assert.match(cpu, /TRIVY_IMAGE_SRC: remote/);
  assert.match(cpu, /name: upstream-cpu-security-\$\{\{ matrix\.engine \}\}-\$\{\{ matrix\.architecture \}\}/);
  assert.doesNotMatch(cpu, /continue-on-error: true|Dockerfile/);
  assert.match(cpu, /steps.header_inventory.outcome == 'success'/);
  assert.match(cpu, /trivy-config: \$\{\{ matrix.engine == 'whispercpp'/);
  assert.match(cpu, /check-upstream-header-image.py/);
  assert.match(cpu, /--approved apps\/inference\/whispercpp\/security\/header-image-inventory.json/);
});

test('CPU scan evidence rejects another architecture or image digest', () => {
  const step = onprem.slice(onprem.indexOf('      - name: Verify the report covers the requested platform and digest'));
  const script = step.match(/node --input-type=module <<'JS'\n([\s\S]*?)^\s+JS$/m)[1]
    .replace(/^\s*import .*;\n/m, '');
  const digest = `ghcr.io/ggml-org/llama.cpp@sha256:${'a'.repeat(64)}`;
  function validate(architecture, repoDigests) {
    runInNewContext(script, {
      readFileSync() { return JSON.stringify({ Metadata: { ImageConfig: { architecture }, RepoDigests: repoDigests } }); },
      process: { env: { ARCHITECTURE: 'arm64', UPSTREAM_CPU_IMAGE: digest } },
    }, { timeout: 100 });
  }
  assert.doesNotThrow(() => validate('arm64', [digest]));
  assert.throws(() => validate('amd64', [digest]), /architecture/);
  assert.throws(() => validate('arm64', [`${digest.slice(0, -1)}b`]), /digest/);
  assert.throws(() => validate(undefined, undefined), /architecture/);
});


test('native basic checks are required when selected and use standard runners', () => {
  const basic = readFileSync(join(__dirname, '../workflows/local-inference-basic.yml'), 'utf8');
  assert.ok(dependencies.includes('local-inference-basic'));
  for (const status of ['failure', 'cancelled', 'skipped']) assert.equal(result(true, 'success', status), 1);
  assert.equal(result(false, 'skipped', 'skipped'), 0);
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
  assert.match(cpu, /exit-code: '1'/);
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
  assert.match(cpu, /^    if: \$\{\{ !inputs\.gpu_candidates_only && inputs\.scan_upstream_images \}\}$/m);
  const llamacpp = onprem.split(/(?=      - name:)/).find(step => step.includes('image-ref: ${{ env.LLAMACPP_IMAGE }}'));
  assert.match(llamacpp, /&& inputs\.scan_upstream_images \}\}/);
  // The inventory still records the pinned image, so it keeps resolving it.
  assert.doesNotMatch(onprem.split(/(?=      - name:)/).find(step => step.includes('Resolve the pinned llama.cpp image')), /scan_upstream_images/);

  const filter = ci.match(/^            upstream_images:\n([\s\S]*?)(?=^            \w+:)/m)[1];
  for (const pattern of ['charts/videoq-inference/values.yaml', 'apps/inference/whispercpp/security/**',
    '.github/scripts/check-upstream-header-image.py', '.github/workflows/onprem-validation.yml']) {
    assert.ok(filter.includes(`'${pattern}'`), pattern);
  }
  assert.match(ci, /scan_upstream_images: \$\{\{ needs\.changes\.outputs\.upstream_images == 'true' \}\}/);
  const operations = readFileSync(join(__dirname, '../workflows/operations.yml'), 'utf8');
  assert.doesNotMatch(operations, /scan_upstream_images/);
});
