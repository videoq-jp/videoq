const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {assess, nativeMasks} = require('./check-vllm-applicability.cjs');
const hash = text => createHash('sha256').update(text).digest('hex');
const image = 'vllm/vllm-openai@sha256:' + 'a'.repeat(64);
const now = new Date('2026-11-12T00:00:00Z');
function fixture() {
  const file = {mode: 420, path: '/usr/include/linux/example.h', sha256: 'b'.repeat(64)};
  const headerHash = hash(JSON.stringify([file]));
  const audio = '{"locked":true}\n';
  const packages = {apt: '2.8.3'};
  const policy = {status: 'not_affected', owner: 'reviewer', scope: 'exact serving workload', references: ['https://example.test/review'],
    reviewedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-30T00:00:00Z', image, os: {ID: 'ubuntu', VERSION_ID: '24.04'},
    osPackages: packages, kernelHeaderInventorySha256: headerHash, kernelHeaderCount: 1, pipVendorBomSha256: 'reviewed-bom',
    runtimePython: {msgpack: '1.2.4'}, audioLockSha256: hash(audio), allowedArgs: [['/models/reviewed']],
    maskedNativeDirectories: [...nativeMasks],
    groups: [{type: 'ubuntu', origin: 'unused-tools', status: 'not_affected', impactStatement: 'APT acquisition is not performed by this serving command', references: ['https://example.test/advisory'],
      vulnerabilities: ['CVE-reviewed'], packages: {apt: {version: '2.8.3', purl: 'pkg:deb/ubuntu/apt@2.8.3?arch=amd64&distro=ubuntu-24.04'}}}]};
  const native = {status: 'passed', inventory: {os: policy.os, packages, kernelHeaders: {inventorySha256: headerHash, count: 1, kernelBinariesOrModules: false, files: [file]},
    pipVendor: {sha256: 'reviewed-bom'}, python: {msgpack: {version: '1.2.4', modulePath: '/usr/local/lib/python3.12/dist-packages/msgpack/__init__.py'}}}};
  const container = {image, command: ['vllm', 'serve'], args: ['/models/reviewed'],
    securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ['ALL']}},
    env: [{name: 'HF_HUB_OFFLINE', value: '1'}, {name: 'HOME', value: '/tmp'}, {name: 'PYTHONPATH', value: '/opt/videoq-audio'}],
    volumeMounts: [{name: 'models', mountPath: '/models', readOnly: true}, {name: 'tmp', mountPath: '/tmp'}, {name: 'shm', mountPath: '/dev/shm'}, {name: 'vllm-audio', mountPath: '/opt/videoq-audio', readOnly: true},
      ...nativeMasks.map(mountPath => ({name: 'unused-native', mountPath, readOnly: true}))]};
  const documents = [{kind: 'ConfigMap', data: {'wheels.json': audio}}, {kind: 'Deployment', spec: {template: {
    metadata: {annotations: {'videoq.io/audio-lock': hash(audio)}}, spec: {automountServiceAccountToken: false,
      securityContext: {runAsNonRoot: true, runAsUser: 10001, seccompProfile: {type: 'RuntimeDefault'}},
      containers: [container], volumes: [{name: 'tmp', emptyDir: {sizeLimit: '4Gi'}}, {name: 'unused-native', emptyDir: {sizeLimit: '1Mi'}}]}}}}];
  const report = {Metadata: {RepoDigests: [image]}, Results: [{Type: 'ubuntu', Vulnerabilities: [{PkgName: 'apt', InstalledVersion: '2.8.3', Severity: 'HIGH', VulnerabilityID: 'CVE-reviewed', PkgIdentifier: {PURL: policy.groups[0].packages.apt.purl}}]}]};
  return {policy, native, profiles: Array.from({length: 10}, () => structuredClone(documents)), report};
}
const run = f => assess(f.report, f.policy, f.native, f.profiles, now);
test('base DNS finding requires the actual patched overlay, bounded parser check and matching lock', () => {
  const f = fixture();
  const replacement = {name: 'dnspython', version: '2.9.2', modulePath: '/opt/videoq-audio/dns/__init__.py', check: 'security.dnspython'};
  f.policy.groups.push({type: 'python-pkg', origin: 'runtime-overlay', status: 'not_affected', impactStatement: 'Pinned patched import required',
    references: ['https://github.com/rthalley/dnspython/security/advisories/GHSA-vvf4-9x63-8xvv'], vulnerabilities: ['CVE-2026-128089'],
    packages: {dnspython: {version: '2.9.1', purl: 'pkg:pypi/dnspython@2.9.1'}}, replacement});
  f.report.Results.push({Type: 'python-pkg', Vulnerabilities: [{PkgName: 'dnspython', InstalledVersion: '2.9.1', Severity: 'HIGH',
    VulnerabilityID: 'CVE-2026-128089', PkgIdentifier: {PURL: 'pkg:pypi/dnspython@2.9.1'}}]});
  const runtime = {status: 'passed', checks: {audioLock: {status: 'passed', details: f.policy.audioLockSha256},
    'security.dnspython': {status: 'passed', details: {version: '2.9.2', modulePath: replacement.modulePath, oversizedWksRejected: true}}}};
  const evaluate = proof => assess(f.report, f.policy, f.native, f.profiles, now, proof);
  assert.equal(evaluate(runtime).accepted.length, 2);
  assert.throws(() => evaluate(undefined));
  for (const mutate of [r => r.status = 'failed', r => r.checks.audioLock.details = 'old-lock',
    r => r.checks['security.dnspython'].status = 'failed', r => r.checks['security.dnspython'].details.version = '2.9.1',
    r => r.checks['security.dnspython'].details.modulePath = '/usr/local/lib/python3.12/dist-packages/dns/__init__.py',
    r => r.checks['security.dnspython'].details.oversizedWksRejected = false]) {
    const copy = structuredClone(runtime); mutate(copy); assert.throws(() => evaluate(copy));
  }
  // Another finding in the same base package remains unassessed.
  f.report.Results[1].Vulnerabilities[0].VulnerabilityID = 'CVE-new';
  assert.equal(evaluate(runtime).blocking.length, 1);
});
test('keeps exact reviewed findings visible while new CVEs, versions and identities block', () => {
  const f = fixture(); const result = run(f);
  assert.equal(result.accepted.length, 1); assert.equal(result.blocking.length, 0);
  for (const mutate of [v => v.VulnerabilityID = 'CVE-new', v => v.InstalledVersion = 'unreviewed', v => v.PkgIdentifier.PURL = 'unreviewed']) {
    const changed = fixture(); mutate(changed.report.Results[0].Vulnerabilities[0]);
    assert.equal(run(changed).blocking.length, 1);
  }
});
test('scanner aliases match an existing assessment without accepting unrelated IDs', () => {
  const f = fixture();
  const finding = f.report.Results[0].Vulnerabilities[0];
  finding.VulnerabilityID = 'GHSA-equivalent';
  finding.Aliases = ['GHSA-equivalent', 'CVE-reviewed'];
  assert.equal(run(f).accepted.length, 1);
  finding.Aliases = ['GHSA-equivalent', 'CVE-unreviewed'];
  assert.equal(run(f).blocking.length, 1);
});
test('rejects expired reviews, changed image files, package managers and runtime paths', () => {
  for (const mutate of [f => f.policy.expiresAt = '2026-11-11T00:00:00Z', f => f.policy.expiresAt = '2027-01-01T00:00:00Z',
    f => f.native.status = 'failed', f => f.native.inventory.kernelHeaders.files[0].sha256 = 'modified',
    f => f.native.inventory.kernelHeaders.kernelBinariesOrModules = true, f => f.native.inventory.pipVendor.sha256 = 'changed',
    f => f.native.inventory.packages = {apt: 'other'}, f => f.native.inventory.python.msgpack.modulePath = '/pip/_vendor/msgpack.py',
    f => f.profiles.pop()]) {
    const changed = fixture(); mutate(changed); assert.throws(() => run(changed));
  }
});
test('startup shells, writable roots, changed models, hooks and injected code invalidate review', () => {
  for (const mutate of [c => c.command = ['sh', '-c'], c => c.args = ['/models/unreviewed'], c => c.lifecycle = {postStart: {}},
    c => c.securityContext.readOnlyRootFilesystem = false, c => c.env.push({name: 'LD_PRELOAD', value: '/tmp/library.so'}),
    c => c.env.push({name: "TORCHDYNAMO_DISABLE", value: "1"}),
    c => c.volumeMounts[0].readOnly = false]) {
    const changed = fixture(); mutate(changed.profiles[0][1].spec.template.spec.containers[0]);
    assert.throws(() => run(changed));
  }
});

test('native findings require exact empty read-only masks and actual runtime proof', () => {
  const f = fixture();
  const directory = '/usr/local/lib/python3.12/dist-packages/mooncake';
  const locations = [directory + '/libetcd_wrapper.so'];
  f.policy.groups.push({type: 'go-module', origin: 'masked-native', status: 'not_affected',
    impactStatement: 'Native code is hidden by mandatory empty read-only mounts', references: ['review'],
    vulnerabilities: ['GO-reviewed'], packages: {stdlib: {version: 'go1.25.10', purl: 'pkg:golang/stdlib@1.25.10', locations}}});
  f.report.Results.push({Type: 'go-module', Vulnerabilities: [{PkgName: 'stdlib', InstalledVersion: 'go1.25.10',
    Severity: 'HIGH', VulnerabilityID: 'GO-reviewed', PkgIdentifier: {PURL: 'pkg:golang/stdlib@1.25.10'}, Locations: locations}]});
  const runtime = {status: 'passed', checks: {'security.maskedNative': {status: 'passed', details: [...nativeMasks]}}};
  const evaluate = (value = f, proof = runtime) => assess(value.report, value.policy, value.native, value.profiles, now, proof);
  assert.equal(evaluate().blocking.length, 0);
  assert.throws(() => evaluate(f, null));
  for (const mutate of [value => value.profiles[0][1].spec.template.spec.containers[0].volumeMounts.pop(),
    value => value.profiles[0][1].spec.template.spec.containers[0].volumeMounts.at(-1).readOnly = false,
    value => value.profiles[0][1].spec.template.spec.containers.push({image: 'writer', volumeMounts: [{name: 'unused-native', mountPath: '/write'}]}),
    value => value.report.Results[1].Vulnerabilities[0].Locations = ['/unmasked/library.so']]) {
    const copy = structuredClone(f); mutate(copy); assert.throws(() => evaluate(copy));
  }
  const copy = structuredClone(f); copy.report.Results[1].Vulnerabilities[0].VulnerabilityID = 'GO-new';
  assert.equal(evaluate(copy).blocking.length, 1);
});

test('75 new kernel CVEs require exact primary records, package locations and native files', () => {
  const policy = require('../../apps/inference/vllm/security/runtime-assessment.json');
  const evidence = require('../../apps/inference/vllm/security/kernel-20261126-review.json');
  const make = () => {
    const f = fixture();
    f.policy.image = evidence.image;
    f.report.Metadata.RepoDigests = [evidence.image];
    for (const documents of f.profiles) documents[1].spec.template.spec.containers[0].image = evidence.image;
    Object.assign(f.policy, {kernelAffectedFileReview: structuredClone(policy.kernelAffectedFileReview),
      kernelHeaderInventorySha256: evidence.inventorySha256, kernelHeaderCount: 990});
    f.policy.osPackages['linux-libc-dev'] = '6.8.0-147.147';
    f.native.inventory.kernelHeaders = {files: structuredClone(evidence.inventoryFiles), count: 990, inventorySha256: evidence.inventorySha256, kernelBinariesOrModules: false};
    f.policy.groups = [structuredClone(policy.groups.find(group => group.origin === 'kernel-headers-exact-files'))];
    f.report.Results[0].Vulnerabilities = evidence.rows.map(row => ({Severity: 'HIGH', VulnerabilityID: row.cve, PkgName: row.package,
      InstalledVersion: row.version, PkgIdentifier: {PURL: row.normalizedPurl}, Locations: row.locations}));
    return f;
  };
  assert.equal(run(make()).accepted.length, 75);
  for (const mutate of [
    f => f.report.Results[0].Vulnerabilities[0].VulnerabilityID = 'CVE-unreviewed',
    f => f.report.Results[0].Vulnerabilities[0].InstalledVersion = '6.8.0-149.149',
    f => f.report.Results[0].Vulnerabilities[0].PkgIdentifier.PURL += '&upstream=other',
  ]) { const f = make(); mutate(f); assert.equal(run(f).blocking.length, 1); }
  for (const mutate of [
    f => f.report.Results[0].Vulnerabilities[0].Locations = ['/tmp/injected.so'],
    f => { const v = f.report.Results[0].Vulnerabilities[0]; v.Aliases = [v.VulnerabilityID]; v.VulnerabilityID = 'forged-alias'; },
    f => f.native.inventory.kernelHeaders.files[0].sha256 = '0'.repeat(64),
    f => f.native.inventory.kernelHeaders.files[0].mode = 0o755,
    f => f.native.inventory.kernelHeaders.files[0].path = '/tmp/header.h',
    f => f.native.inventory.kernelHeaders.kernelBinariesOrModules = true,
    f => f.policy.kernelAffectedFileReview.sha256 = '0'.repeat(64),
    f => f.policy.kernelAffectedFileReview.file = '../runtime-assessment.json',
    f => f.profiles[0][1].spec.template.spec.securityContext.runAsUser = 0,
    f => f.profiles[0][1].spec.template.spec.securityContext.seccompProfile.type = 'Unconfined',
    f => f.profiles[0][1].spec.template.spec.containers[0].securityContext.capabilities.drop = [],
  ]) { const f = make(); mutate(f); assert.throws(() => run(f)); }
});

test('mask schema rejects omission, relocation, write access and unreviewed native paths', () => {
  for (const mutate of [f => delete f.policy.maskedNativeDirectories,
    f => f.policy.maskedNativeDirectories.pop(),
    f => f.policy.maskedNativeDirectories.push('/usr/lib'),
    f => f.profiles[0][1].spec.template.spec.containers[0].volumeMounts.at(-1).readOnly = false,
    f => f.profiles[0][1].spec.template.spec.containers[0].volumeMounts.at(-1).mountPath += '/nested',
    f => f.profiles[0][1].spec.template.spec.volumes.at(-1).emptyDir = {medium: 'Memory'},
    f => f.profiles[0][1].spec.template.spec.containers[0].args = ['/models/video-unreviewed']]) {
    const f = fixture(); mutate(f); assert.throws(() => run(f));
  }
});

test('required actual-render gate has locked dependency and Helm prerequisites before native execution', () => {
  const {readFileSync} = require('node:fs');
  const workflow = readFileSync('.github/workflows/upstream-vllm.yml', 'utf8');
  const install = workflow.indexOf('npm ci --ignore-scripts --workspace @videoq/api');
  const helm = workflow.indexOf('name: Install the reviewed Helm renderer');
  const gate = workflow.indexOf('name: Validate all supported native profiles and mandatory masks');
  const runtime = workflow.indexOf('name: Verify upstream audio imports');
  assert.ok(install >= 0 && helm > install && gate > helm && runtime > gate);
  const gateBlock = workflow.slice(gate, workflow.indexOf('      - ', gate));
  assert.ok(gateBlock.includes('HELM_BIN: ${{ runner.temp }}/helm/helm'));
  assert.ok(gateBlock.includes('node .github/scripts/check-vllm-render.cjs'));
  assert.ok(!gateBlock.includes('continue-on-error') && !gateBlock.includes('if:'));
  for (const name of ['upstream-vllm.yml', 'patched-audio-candidate.yml']) {
    const text = readFileSync('.github/workflows/' + name, 'utf8');
    for (const directory of nativeMasks) assert.ok(text.includes('--tmpfs ' + directory + ':ro,size=1m'));
  }
});

// Historical unit evidence only. No production module/cache/global is changed.
// Substitute only the two exact historical source/proof paths in a separate
// compiled module; every other filesystem read remains the real reader.
function historicalMaskedEvaluator() {
  const fs = require('node:fs'), path = require('node:path');
  const evaluator = path.join(__dirname, 'check-vllm-applicability.cjs');
  const runtime = path.join(__dirname, 'check-vllm-runtime.py');
  const archived = fs.readFileSync(path.join(__dirname, 'fixtures/vllm-historical/check-vllm-runtime-eec22a49.py.txt'));
  assert.equal(hash(archived), '511807d5a341b681c6ff6658c058cfcb049f7fa59dd1d68264b1cd153fc9264b');
  const proofPath = path.join(__dirname, '../../apps/inference/vllm/security/masked-ffmpeg-20261126-review.json');
  const oldProof = fs.readFileSync(path.join(__dirname, 'fixtures/vllm-historical/masked-ffmpeg-eec22a49-review.json.txt'));
  assert.equal(hash(oldProof), '92c1a5eb3848dc77178b439e4be47e274b576170106af10f2ca556c373effc63');
  const isolated = {exports: {}};
  const readFileSync = (file, ...options) => {
    const target = path.resolve(String(file));
    const bytes = target === runtime ? archived : target === proofPath ? oldProof : undefined;
    return bytes ? (options[0] ? bytes.toString(typeof options[0] === 'string' ? options[0] : options[0].encoding) : bytes)
      : fs.readFileSync(file, ...options);
  };
  const compile = require('node:vm').compileFunction(fs.readFileSync(evaluator, 'utf8'),
    ['require', 'module', 'exports', '__dirname'], {filename: evaluator});
  compile(name => name === 'node:fs' ? {...fs, readFileSync} : require(name), isolated, isolated.exports, __dirname);
  return isolated.exports.assess;
}
const historicalAssess = historicalMaskedEvaluator();

function exactMaskedFixture(historical = true) {
  const policy = structuredClone(require('../../apps/inference/vllm/security/runtime-assessment.json'));
  // Historical cases exercise only the policy evidence available at that time.
  if (historical) {
    delete policy.additionalKernelAffectedFileReview;
    delete policy.additionalMaskedFfmpegReview;
  }
  const evidence = historical
    ? JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,
      'fixtures/vllm-historical/masked-ffmpeg-eec22a49-review.json.txt'), 'utf8'))
    : require('../../apps/inference/vllm/security/masked-ffmpeg-20261126-review.json');
  const f = fixture();
  f.policy = policy;
  if (historical) {
    f.policy.runtimeProbeSourceSha256 = '511807d5a341b681c6ff6658c058cfcb049f7fa59dd1d68264b1cd153fc9264b';
    f.policy.maskedFfmpegReview.sha256 = '92c1a5eb3848dc77178b439e4be47e274b576170106af10f2ca556c373effc63';
  }
  f.native = {status: 'passed', inventory: structuredClone(evidence.nativeInventory)};
  f.runtime = {status: 'passed', checks: structuredClone(evidence.requiredRuntimeChecks)};
  const documents = f.profiles[0];
  const lock = require('node:fs').readFileSync(historical
    ? require('node:path').join(__dirname, 'fixtures/vllm-historical/audio-wheels-eec22a49.json.txt')
    : 'charts/videoq-inference/files/vllm-audio-wheels.json', 'utf8');
  if (historical) {
    assert.equal(hash(lock), '4bd306454e793d6e2dcb67a94db771e703e9b5c2f7202ae98d8b53b4d27b4f7e');
    f.policy.audioLockSha256 = hash(lock);
    // This receipt exercised the historical guard, never the current adapter.
    f.policy.audioGuardSha256 = 'ea09f7753f1ad771f9d7acc6b1a33289e20b6f59e83ac367e03513ffb3a2bb5a';
    assert.equal(JSON.parse(lock).runtimeGuardSha256, f.policy.audioGuardSha256);
  }
  documents[0].data['wheels.json'] = lock;
  const pod = documents[1].spec.template.spec, container = pod.containers[0];
  documents[1].spec.template.metadata.annotations['videoq.io/audio-lock'] = policy.audioLockSha256;
  container.image = policy.image; container.args = policy.allowedArgs[0];
  container.env = [{name: 'HF_HUB_OFFLINE', value: '1'}, {name: 'HOME', value: '/tmp'}, {name: 'PYTHONPATH', value: '/opt/videoq-audio'}];
  container.volumeMounts = [{name: 'models', mountPath: '/models', readOnly: true}, {name: 'tmp', mountPath: '/tmp'},
    {name: 'shm', mountPath: '/dev/shm'}, {name: 'vllm-audio', mountPath: '/opt/videoq-audio', readOnly: true},
    ...nativeMasks.map(mountPath => ({name: 'unused-native', mountPath, readOnly: true}))];
  pod.volumes.push({name: 'unused-native', emptyDir: {sizeLimit: '1Mi'}});
  f.profiles = Array.from({length: 10}, () => structuredClone(documents));
  f.report = {Metadata: {RepoDigests: [policy.image], ImageConfig: {architecture: 'amd64', os: 'linux'}}, Results: [{Type: 'binary',
    Vulnerabilities: evidence.rows.map(row => ({Severity: 'CRITICAL', VulnerabilityID: row.cve, PkgName: row.package,
      InstalledVersion: row.version, PkgIdentifier: {PURL: row.purl}, Locations: [...row.locations]}))}]};
  return f;
}
const runMasked = f => historicalAssess(f.report, f.policy, f.native, f.profiles, new Date('2026-11-26T00:00:00Z'), f.runtime);
test('historical eec22 proof unit case requires complete native evidence; separate audio is untouched', () => {
  const f = exactMaskedFixture();
  assert.equal(runMasked(f).accepted.length, 11);
  const audioPolicy = require('../../apps/inference/vllm/security/runtime-assessment.json').audioAssessments;
  assert.ok(Array.isArray(audioPolicy));
  assert.ok(!JSON.stringify(audioPolicy).includes('CVE-2026-135736'));
  const evidence = require('../../apps/inference/vllm/security/masked-ffmpeg-20261126-review.json');
  const audioResult = require('./check-vllm-scan.cjs').assessAudioRuntime({blocking: evidence.rows.map(row => ({
    VulnerabilityID: row.cve, PkgName: 'ffmpeg', InstalledVersion: '9.0.2',
    PkgIdentifier: {PURL: 'pkg:generic/ffmpeg@9.0.2'}, Locations: f.runtime.checks['security.servingAudioBoundary'].details.loadedFfmpegLibraries,
  }))}, f.policy, f.runtime);
  assert.equal(audioResult.blocking.length, 11); assert.equal(audioResult.accepted.length, 0);
  for (const mutate of [f => f.report.Results[0].Vulnerabilities[0].VulnerabilityID = 'CVE-unreviewed',
    f => f.report.Results[0].Vulnerabilities[0].InstalledVersion = '9.0.2',
    f => f.report.Results[0].Vulnerabilities[0].PkgIdentifier.PURL = 'pkg:generic/ffmpeg@9.0.2']) {
    const changed = exactMaskedFixture(); mutate(changed); assert.equal(runMasked(changed).blocking.length, 1);
  }
});
test('historical masked-proof unit controls reject mutated native/source/location/profile evidence', () => {
  for (const mutate of [
    f => f.runtime = undefined, f => f.runtime.status = 'failed', f => f.runtime.checks = {},
    f => delete f.runtime.checks['security.maskedNativeDenial'],
    f => f.runtime.checks['security.maskedNativeDenial'].details.absoluteLoadsDenied.pop(),
    f => f.runtime.checks['security.maskedNativeDenial'].details.imports[0].result = 'code_imported',
    f => f.runtime.checks['security.maskedNativeDenial'].details.torchcodec.importsDenied.pop(),
    f => f.runtime.checks['security.maskedNative'].details.pop(),
    f => f.runtime.checks['security.servingAudioBoundary'].details.loadedFfmpegLibraries.push('/usr/lib/libavcodec.so'),
    f => f.runtime.checks['security.servingAudioBoundary'].details.diagnosticImportMaps.afterMediaAudioImport = [],
    f => f.runtime.checks['security.servingAudioBoundary'].details.pyavWheelMembers['av/filter/graph.abi3.so'] = '0'.repeat(64),
    f => f.runtime.checks['security.servingAudioBoundary'].details.validCases.pop(),
    f => f.runtime.checks['security.servingAudioBoundary'].details.calls = [],
    f => f.runtime.checks['security.servingAudioBoundary'].details.nativeFilterTraceComplete = true,
    f => f.native.inventory.kernelHeaders.files[0].sha256 = '0'.repeat(64),
    f => f.policy.runtimeProbeSourceSha256 = '0'.repeat(64),
    f => f.policy.maskedFfmpegReview.sha256 = '0'.repeat(64),
    f => f.policy.maskedFfmpegReview.file = '../runtime-assessment.json',
    f => delete f.policy.groups.find(g => g.exactFindingReview).exactFindingReview,
    f => f.report.Metadata.ImageConfig.architecture = 'arm64',
    f => f.report.Results[0].Vulnerabilities[0].Locations.push('/unmasked/libavcodec.so'),
    f => { const v = f.report.Results[0].Vulnerabilities[0]; v.Aliases = [v.VulnerabilityID]; v.VulnerabilityID = 'forged-alias'; },
    f => f.profiles[0][1].spec.template.spec.containers[0].volumeMounts.pop(),
    f => f.profiles[0][1].spec.template.spec.containers[0].volumeMounts.at(-1).readOnly = false,
  ]) { const f = exactMaskedFixture(); mutate(f); assert.throws(() => runMasked(f)); }
});

// This calls the actual production evaluator and current source; no archived
// source substitution is in its path. The old actual receipt must stay blocked.
test('active production evaluator still rejects historical proof after explicit fresh proof review', () => {
  const f = exactMaskedFixture(false);
  const old = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,
    'fixtures/vllm-historical/masked-ffmpeg-eec22a49-review.json.txt'), 'utf8'));
  f.runtime = {status: 'passed', checks: structuredClone(old.requiredRuntimeChecks)};
  const activeSourceHash = hash(require('node:fs').readFileSync(require('node:path').join(__dirname, 'check-vllm-runtime.py')));
  assert.equal(f.policy.runtimeProbeSourceSha256, activeSourceHash);
  assert.equal(hash(require('node:fs').readFileSync('charts/videoq-inference/files/vllm-audio-wheels.json')), f.policy.audioLockSha256);
  const oldSourceHash = '511807d5a341b681c6ff6658c058cfcb049f7fa59dd1d68264b1cd153fc9264b';
  assert.notEqual(activeSourceHash, oldSourceHash);
  const current = require('../../apps/inference/vllm/security/masked-ffmpeg-20261126-review.json');
  assert.throws(() => assess(f.report, f.policy, f.native, f.profiles,
    new Date('2026-11-27T10:00:00Z'), f.runtime), error => error.code === 'ERR_ASSERTION'
      && error.actual === f.runtime.checks
      && hash(JSON.stringify(error.expected)) === hash(JSON.stringify(current.requiredRuntimeChecks)));
});

test('current policy guard identity matches production source, locked adapter and probe pin', () => {
  const fs = require('node:fs'), path = require('node:path');
  const policy = require('../../apps/inference/vllm/security/runtime-assessment.json');
  const root = path.join(__dirname, '../..');
  const actualGuard = hash(fs.readFileSync(path.join(root, 'apps/inference/whisper/audio_guard.py')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'charts/videoq-inference/files/vllm-audio-wheels.json'), 'utf8'));
  const probe = fs.readFileSync(path.join(__dirname, 'check-vllm-runtime.py'), 'utf8');
  const pin = probe.match(/^REVIEWED_AUDIO_GUARD_SHA256 = "([a-f0-9]{64})"$/m);
  assert.ok(pin, 'Probe must explicitly pin the reviewed production adapter');
  assert.equal(policy.audioGuardSha256, actualGuard);
  assert.equal(lock.runtimeGuardSha256, actualGuard);
  assert.equal(pin[1], actualGuard);
});

test('active exact 9.1 proof accepts only the reviewed masked-image tuples and rejects mutated evidence', () => {
  const evaluate = f => assess(f.report, f.policy, f.native, f.profiles,
    new Date('2026-11-27T10:00:00Z'), f.runtime);
  assert.equal(evaluate(exactMaskedFixture(false)).accepted.length, 11);
  const current = require('../../apps/inference/vllm/security/masked-ffmpeg-20261126-review.json');
  const historical = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,
    'fixtures/vllm-historical/masked-ffmpeg-eec22a49-review.json.txt'), 'utf8'));
  assert.deepEqual(current.rows, historical.rows, 'No CVE/tuple/primary-record expansion');
  assert.equal(current.artifactId, 15080457487);
  assert.equal(current.workflowJobConclusion, 'failure');
  assert.equal(current.nativeStepConclusion, 'success');
  for (const mutate of [
    f => f.runtime = undefined,
    f => f.runtime.status = 'failed',
    f => f.runtime.checks['security.audio'].details.guardSha256 = '0'.repeat(64),
    f => f.runtime.checks['security.servingAudioBoundary'].details.pyavRelease.ffmpegVersion = '9.0.2',
    f => f.runtime.checks['security.servingAudioBoundary'].details.pyavRelease.wheelSha256 = '0'.repeat(64),
    f => f.runtime.checks['security.servingAudioBoundary'].details.validCases.pop(),
    f => f.runtime.checks['security.servingAudioBoundary'].details.pyavWheelMembers['av/filter/graph.abi3.so'] = '0'.repeat(64),
    f => f.runtime.checks['security.servingAudioBoundary'].details.diagnosticImportMaps.afterMediaAudioImport.push('/usr/lib/libswscale.so'),
    f => f.runtime.checks['security.maskedNative'].details.pop(),
    f => f.runtime.checks['security.maskedNativeDenial'].details.absoluteLoadsDenied.pop(),
    f => f.runtime.checks['security.maskedNativeDenial'].details.torchcodec.importsDenied.pop(),
    f => f.native.inventory.kernelHeaders.files[0].mode = 0o755,
    f => f.report.Results[0].Vulnerabilities[0].Locations.push('/unmasked/libavcodec.so'),
    f => f.profiles[0][1].spec.template.spec.containers[0].volumeMounts.at(-1).readOnly = false,
    f => f.policy.runtimeProbeSourceSha256 = '0'.repeat(64),
  ]) { const f = exactMaskedFixture(false); mutate(f); assert.throws(() => evaluate(f)); }
  for (const mutate of [
    f => f.report.Results[0].Vulnerabilities[0].VulnerabilityID = 'CVE-unreviewed',
    f => f.report.Results[0].Vulnerabilities[0].InstalledVersion = '9.1',
    f => f.report.Results[0].Vulnerabilities[0].PkgIdentifier.PURL = 'pkg:generic/ffmpeg@9.1',
  ]) { const f = exactMaskedFixture(false); mutate(f); assert.equal(evaluate(f).blocking.length, 1); }
});

function additionalFindingFixture() {
  const f = exactMaskedFixture(false);
  const kernel = require('../../apps/inference/vllm/security/kernel-20261127-additional-review.json');
  const masked = require('../../apps/inference/vllm/security/masked-ffmpeg-20261127-additional-review.json');
  f.report.Results = [
    {Type: 'ubuntu', Vulnerabilities: kernel.rows.map(row => ({Severity: 'HIGH', VulnerabilityID: row.cve,
      PkgName: row.package, InstalledVersion: row.version, PkgIdentifier: {PURL: row.normalizedPurl}, Locations: [...row.locations]}))},
    {Type: 'binary', Vulnerabilities: masked.rows.map(row => ({Severity: 'HIGH', VulnerabilityID: row.cve,
      PkgName: row.package, InstalledVersion: row.version, PkgIdentifier: {PURL: row.purl}, Locations: [...row.locations]}))},
  ];
  return f;
}
const runAdditional = f => assess(f.report, f.policy, f.native, f.profiles,
  new Date('2026-11-27T10:00:00Z'), f.runtime);

test('34 additional kernel records and two masked FFmpeg findings require their exact separate reviews', () => {
  const f = additionalFindingFixture();
  const result = runAdditional(f);
  assert.equal(result.accepted.length, 36);
  assert.equal(result.blocking.length, 0);
  assert.equal(new Set(result.accepted.map(v => v.VulnerabilityID)).size, 36);
  const kernel = require('../../apps/inference/vllm/security/kernel-20261127-additional-review.json');
  assert.deepEqual(kernel.rows.find(row => row.cve === 'CVE-2026-99804').affectedFiles, ['io_uring/io-wq.c']);
  assert.equal(kernel.rows.length, 34);
  assert.equal(kernel.sourceCommit, 'b0cd7b5412b9aa02e40e3ab97d536b87dc57f8bc');
  const masked = require('../../apps/inference/vllm/security/masked-ffmpeg-20261127-additional-review.json');
  assert.equal(masked.workflowRunId, 45966108942);
  assert.equal(masked.workflowJobId, 140395168535);
  assert.equal(masked.artifactId, 15183042431);
  assert.equal(masked.nativeStepConclusion, 'success');
  assert.equal(masked.rawAudioMatches, 0);
  assert.equal(masked.rawAudioIgnoredMatches, 0);
  assert.deepEqual(masked.requiredRuntimeChecks, f.runtime.checks);
  // Preserve both older reviews rather than broadening their original tuples.
  assert.equal(f.policy.kernelAffectedFileReview.count, 75);
  assert.equal(f.policy.maskedFfmpegReview.count, 11);
});

test('new CVEs, versions and PURLs cannot inherit either additional review', () => {
  for (const index of [0, 1]) {
    for (const mutate of [v => v.VulnerabilityID = 'CVE-unreviewed', v => v.InstalledVersion = 'unreviewed',
      v => v.PkgIdentifier.PURL = 'pkg:generic/unreviewed@1']) {
      const f = additionalFindingFixture(); mutate(f.report.Results[index].Vulnerabilities[0]);
      assert.equal(runAdditional(f).blocking.length, 1);
    }
    const f = additionalFindingFixture(), finding = f.report.Results[index].Vulnerabilities[0];
    finding.Aliases = [finding.VulnerabilityID]; finding.VulnerabilityID = 'forged-alias';
    assert.throws(() => runAdditional(f));
  }
});

test('additional reviews reject missing proof, changed native mappings, unsafe workloads and altered references', () => {
  for (const mutate of [
    f => delete f.policy.additionalKernelAffectedFileReview,
    f => delete f.policy.kernelAffectedFileReview,
    f => delete f.policy.additionalMaskedFfmpegReview,
    f => f.policy.additionalKernelAffectedFileReview.sha256 = '0'.repeat(64),
    f => f.policy.additionalKernelAffectedFileReview.count = 35,
    f => f.policy.additionalKernelAffectedFileReview.file = '../runtime-assessment.json',
    f => f.policy.additionalMaskedFfmpegReview.sha256 = '0'.repeat(64),
    f => f.policy.additionalMaskedFfmpegReview.count = 3,
    f => f.policy.additionalMaskedFfmpegReview.file = '../runtime-assessment.json',
    f => f.native.inventory.kernelHeaders.files[0].path = '/usr/include/asm-generic/tlb.h',
    f => f.native.inventory.kernelHeaders.kernelBinariesOrModules = true,
    f => f.report.Results[0].Vulnerabilities[0].Locations.push('/tmp/injected'),
    f => f.report.Results[1].Vulnerabilities[0].Locations.push('/opt/videoq-audio/unmasked.so'),
    f => f.report.Metadata.ImageConfig.architecture = 'arm64',
    f => f.runtime = undefined,
    f => f.runtime.checks['security.maskedNativeDenial'].details.absoluteLoadsDenied.pop(),
    f => f.runtime.checks['security.servingAudioBoundary'].details.loadedFfmpegLibraries.push('/usr/lib/libavformat.so'),
    f => f.profiles[0][1].spec.template.spec.containers[0].volumeMounts.at(-1).readOnly = false,
    f => f.report.Results[0].ModifiedFindings = [{id: 'suppressed'}],
    f => f.policy.expiresAt = '2026-12-11T00:00:00Z',
  ]) { const f = additionalFindingFixture(); mutate(f); assert.throws(() => runAdditional(f)); }
  const f = additionalFindingFixture();
  assert.throws(() => assess(f.report, f.policy, f.native, f.profiles,
    new Date('2026-11-27T08:59:59Z'), f.runtime), /not yet valid/);
  assert.throws(() => assess(f.report, f.policy, f.native, f.profiles,
    new Date(f.policy.expiresAt), f.runtime), /expired/);
});

test('the two additional masked image CVEs never waive findings in the loaded audio overlay', () => {
  const f = additionalFindingFixture();
  const findings = f.report.Results[1].Vulnerabilities.map(v => ({...v, InstalledVersion: '9.1',
    PkgIdentifier: {PURL: 'pkg:generic/ffmpeg@9.1'},
    Locations: f.runtime.checks['security.servingAudioBoundary'].details.loadedFfmpegLibraries}));
  const result = require('./check-vllm-scan.cjs').assessAudioRuntime({blocking: findings}, f.policy, f.runtime);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.blocking.length, 2);
});

test('November 28 boxblur review is limited to the exact masked image tuple and current runtime proof', () => {
  const evidence = require('../../apps/inference/vllm/security/masked-ffmpeg-20261128-review.json');
  const make = () => {
    const f = exactMaskedFixture(false);
    f.runtime.checks = structuredClone(evidence.requiredRuntimeChecks);
    f.native.inventory = structuredClone(evidence.nativeInventory);
    f.report.Results = [{ Type: 'binary', Vulnerabilities: evidence.rows.map(row => ({
      Severity: 'HIGH', PkgName: row.package, InstalledVersion: row.version, VulnerabilityID: row.cve,
      PkgIdentifier: { PURL: row.purl }, Locations: [...row.locations],
    })) }];
    return f;
  };
  const run = f => assess(f.report, f.policy, f.native, f.profiles, new Date('2026-11-29T00:00:00Z'), f.runtime);
  assert.equal(run(make()).accepted.length, 1);
  assert.equal(evidence.workflowRunId, 46123718202);
  assert.equal(evidence.artifactId, 15254468052);
  assert.equal(evidence.nativeStepConclusion, 'success');
  assert.equal(evidence.rawImageIgnoredMatches, 0);
  assert.equal(evidence.rawAudioMatches, 0);
  assert.match(evidence.rows[0].affectedSource, /vf_boxblur/);
  for (const mutate of [
    f => delete f.policy.latestMaskedFfmpegReview,
    f => f.policy.latestMaskedFfmpegReview.sha256 = '0'.repeat(64),
    f => f.runtime.checks['security.maskedNativeDenial'].details.absoluteLoadsDenied.pop(),
    f => f.report.Results[0].Vulnerabilities[0].Locations.push('/unmasked/libavfilter.so'),
    f => f.runtime.checks['security.servingAudioBoundary'].details.loadedFfmpegLibraries.push('/usr/lib/libavfilter.so'),
  ]) { const f = make(); mutate(f); assert.throws(() => run(f)); }
  for (const mutate of [
    v => v.VulnerabilityID = 'CVE-unreviewed',
    v => v.InstalledVersion = '8.1.2',
    v => v.PkgIdentifier.PURL = 'pkg:generic/ffmpeg@9.1',
  ]) { const f = make(); mutate(f.report.Results[0].Vulnerabilities[0]); assert.equal(run(f).blocking.length, 1); }
  assert.throws(() => { const f = make(); return assess(f.report, f.policy, f.native, f.profiles, new Date('2026-12-11T00:00:00Z'), f.runtime); });
});
