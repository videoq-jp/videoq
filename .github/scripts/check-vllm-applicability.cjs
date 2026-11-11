// Evaluate exact findings only after verifying the image's actual files and workload.
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const checksum = value => createHash('sha256').update(value).digest('hex');

function verifyWorkload(documents, policy) {
  let servers = 0;
  const lock = documents.find(d => d.kind === 'ConfigMap' && d.data?.['wheels.json']);
  assert.ok(lock, 'Missing runtime audio lock');
  assert.equal(checksum(lock.data['wheels.json']), policy.audioLockSha256);
  for (const deployment of documents.filter(d => d.kind === 'Deployment')) {
    const pod = deployment.spec.template.spec;
    for (const init of pod.initContainers || []) assert.notEqual(init.image, policy.image, 'Do not use the assessed engine for setup');
    for (const container of pod.containers) {
      if (container.image !== policy.image) continue;
      servers++;
      assert.equal(pod.automountServiceAccountToken, false);
      assert.equal(pod.hostNetwork, undefined);
      assert.equal(pod.securityContext.runAsNonRoot, true);
      assert.equal(pod.securityContext.runAsUser, 10001);
      assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
      assert.equal(deployment.spec.template.metadata.annotations['videoq.io/audio-lock'], policy.audioLockSha256);
      assert.deepEqual(container.command, ['vllm', 'serve']);
      assert.ok(policy.allowedArgs.some(args => JSON.stringify(args) === JSON.stringify(container.args)), 'Unreviewed engine command arguments');
      assert.equal(container.lifecycle, undefined);
      assert.equal(container.envFrom, undefined);
      assert.equal(container.securityContext.runAsUser, undefined);
      assert.equal(container.securityContext.privileged, undefined);
      assert.equal(container.securityContext.allowPrivilegeEscalation, false);
      assert.equal(container.securityContext.readOnlyRootFilesystem, true);
      assert.deepEqual(container.securityContext.capabilities, {drop: ['ALL']});
      for (const [key, value] of [['HF_HUB_OFFLINE', '1'], ['HOME', '/tmp'], ['PYTHONPATH', '/opt/videoq-audio']]) {
        assert.equal(container.env.find(e => e.name === key)?.value, value);
      }
      const alias = container.args[container.args.indexOf("--served-model-name") + 1];
      assert.equal(container.env.find(e => e.name === "TORCHDYNAMO_DISABLE")?.value,
        policy.runtimeEnv?.[alias]?.TORCHDYNAMO_DISABLE);
      assert.ok(!container.env.some(e => /^(LD_|BASH_ENV|ENV$|PYTHONSTARTUP)/.test(e.name)));
      assert.deepEqual(container.volumeMounts, [
        {name: 'models', mountPath: '/models', readOnly: true},
        {name: 'tmp', mountPath: '/tmp'},
        {name: 'shm', mountPath: '/dev/shm'},
        {name: 'vllm-audio', mountPath: '/opt/videoq-audio', readOnly: true},
      ]);
      assert.deepEqual(pod.volumes.find(v => v.name === 'tmp'), {name: 'tmp', emptyDir: {sizeLimit: '4Gi'}});
    }
  }
  assert.ok(servers > 0, 'No assessed vLLM servers rendered');
}

function assess(report, policy, native, profiles, now = new Date()) {
  assert.equal(policy.status, 'not_affected');
  assert.ok(policy.owner && policy.scope && policy.references.length);
  const reviewed = Date.parse(policy.reviewedAt), expires = Date.parse(policy.expiresAt);
  assert.ok(Number.isFinite(reviewed) && Number.isFinite(expires));
  assert.ok(now >= reviewed && now < expires && expires - reviewed <= 30 * 86400000, 'Assessment expired or invalid');
  assert.ok(report.Metadata.RepoDigests.includes(policy.image));
  assert.equal(native.status, 'passed', 'Actual image inventory must be verified');
  const actual = native.inventory;
  assert.deepEqual(actual.os, policy.os);
  assert.deepEqual(actual.packages, policy.osPackages);
  assert.equal(actual.kernelHeaders.inventorySha256, policy.kernelHeaderInventorySha256);
  assert.equal(actual.kernelHeaders.count, policy.kernelHeaderCount);
  assert.equal(actual.kernelHeaders.files.length, policy.kernelHeaderCount);
  const files = actual.kernelHeaders.files.map(f => ({mode: f.mode, path: f.path, sha256: f.sha256})).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.equal(checksum(JSON.stringify(files)), policy.kernelHeaderInventorySha256, 'Header inventory checksum must match its actual entries');
  assert.equal(actual.kernelHeaders.kernelBinariesOrModules, false);
  assert.equal(actual.pipVendor.sha256, policy.pipVendorBomSha256);
  for (const [name, version] of Object.entries(policy.runtimePython)) {
    assert.equal(actual.python[name].version, version);
    assert.ok(actual.python[name].modulePath.startsWith('/usr/local/lib/python3.12/dist-packages/'));
    assert.ok(!actual.python[name].modulePath.includes('/pip/_vendor/'));
  }
  assert.equal(profiles.length, 10, 'Review all five NVIDIA profiles before and after offline provisioning');
  profiles.forEach(documents => verifyWorkload(documents, policy));
  const accepted = [], blocking = [];
  for (const result of report.Results) {
    assert.ok(!result.ModifiedFindings?.length && !result.ExperimentalModifiedFindings?.length, 'Use unsuppressed raw findings');
    for (const finding of result.Vulnerabilities || []) {
      if (!['HIGH', 'CRITICAL', 'UNKNOWN'].includes(finding.Severity)) continue;
      const group = policy.groups.find(group => group.type === result.Type && group.vulnerabilities.includes(finding.VulnerabilityID)
        && group.packages[finding.PkgName]?.version === finding.InstalledVersion
        && group.packages[finding.PkgName]?.purl === finding.PkgIdentifier?.PURL);
      if (group) {
        assert.equal(group.status, 'not_affected');
        assert.ok(group.impactStatement && group.references.length);
        assert.ok(['kernel-headers', 'unused-tools', 'openssl-unused-protocol', 'pip-vendor'].includes(group.origin));
      }
      if (group?.origin === 'pip-vendor') {
        const packages = (result.Packages || []).filter(p => p.Identifier?.PURL === finding.PkgIdentifier.PURL);
        assert.ok(packages.length && packages.every(p => p.AnalyzedBy === 'sbom'), 'A reviewed pip-vendor finding also matches installed runtime metadata');
      }
      (group ? accepted : blocking).push(finding);
    }
  }
  return {image: policy.image, reviewedAt: policy.reviewedAt, expiresAt: policy.expiresAt, scope: policy.scope, accepted, blocking};
}
module.exports = {assess, verifyWorkload};
