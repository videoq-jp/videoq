const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {assess} = require('./check-vllm-applicability.cjs');
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
    groups: [{type: 'ubuntu', origin: 'unused-tools', status: 'not_affected', impactStatement: 'APT acquisition is not performed by this serving command', references: ['https://example.test/advisory'],
      vulnerabilities: ['CVE-reviewed'], packages: {apt: {version: '2.8.3', purl: 'pkg:deb/ubuntu/apt@2.8.3?arch=amd64&distro=ubuntu-24.04'}}}]};
  const native = {status: 'passed', inventory: {os: policy.os, packages, kernelHeaders: {inventorySha256: headerHash, count: 1, kernelBinariesOrModules: false, files: [file]},
    pipVendor: {sha256: 'reviewed-bom'}, python: {msgpack: {version: '1.2.4', modulePath: '/usr/local/lib/python3.12/dist-packages/msgpack/__init__.py'}}}};
  const container = {image, command: ['vllm', 'serve'], args: ['/models/reviewed'],
    securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ['ALL']}},
    env: [{name: 'HF_HUB_OFFLINE', value: '1'}, {name: 'HOME', value: '/tmp'}, {name: 'PYTHONPATH', value: '/opt/videoq-audio'}],
    volumeMounts: [{name: 'models', mountPath: '/models', readOnly: true}, {name: 'tmp', mountPath: '/tmp'}, {name: 'shm', mountPath: '/dev/shm'}, {name: 'vllm-audio', mountPath: '/opt/videoq-audio', readOnly: true}]};
  const documents = [{kind: 'ConfigMap', data: {'wheels.json': audio}}, {kind: 'Deployment', spec: {template: {
    metadata: {annotations: {'videoq.io/audio-lock': hash(audio)}}, spec: {automountServiceAccountToken: false,
      securityContext: {runAsNonRoot: true, runAsUser: 10001, seccompProfile: {type: 'RuntimeDefault'}},
      containers: [container], volumes: [{name: 'tmp', emptyDir: {sizeLimit: '4Gi'}}]}}}}];
  const report = {Metadata: {RepoDigests: [image]}, Results: [{Type: 'ubuntu', Vulnerabilities: [{PkgName: 'apt', InstalledVersion: '2.8.3', Severity: 'HIGH', VulnerabilityID: 'CVE-reviewed', PkgIdentifier: {PURL: policy.groups[0].packages.apt.purl}}]}]};
  return {policy, native, profiles: Array.from({length: 10}, () => structuredClone(documents)), report};
}
const run = f => assess(f.report, f.policy, f.native, f.profiles, now);
test('keeps exact reviewed findings visible while new CVEs, versions and identities block', () => {
  const f = fixture(); const result = run(f);
  assert.equal(result.accepted.length, 1); assert.equal(result.blocking.length, 0);
  for (const mutate of [v => v.VulnerabilityID = 'CVE-new', v => v.InstalledVersion = 'unreviewed', v => v.PkgIdentifier.PURL = 'unreviewed']) {
    const changed = fixture(); mutate(changed.report.Results[0].Vulnerabilities[0]);
    assert.equal(run(changed).blocking.length, 1);
  }
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
