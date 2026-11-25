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
