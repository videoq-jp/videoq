// Evaluate exact findings only after verifying the image's actual files and workload.
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const checksum = value => createHash('sha256').update(value).digest('hex');

const nativeMasks = Object.freeze(['PyNvVideoCodec', 'opencv_python_headless.libs', 'mooncake', 'torchcodec']
  .map(name => '/usr/local/lib/python3.12/dist-packages/' + name));
function verifyWorkload(documents, policy) {
  assert.deepEqual(policy.maskedNativeDirectories, nativeMasks, 'All four exact production native masks are required');
  let servers = 0;
  const lock = documents.find(d => d.kind === 'ConfigMap' && d.data?.['wheels.json']);
  assert.ok(lock, 'Missing runtime audio lock');
  assert.equal(checksum(lock.data['wheels.json']), policy.audioLockSha256);
  for (const deployment of documents.filter(d => d.kind === 'Deployment')) {
    const pod = deployment.spec.template.spec;
    for (const init of pod.initContainers || []) assert.notEqual(init.image, policy.image, 'Do not use the assessed engine for setup');
    if (policy.maskedNativeDirectories) {
      for (const participant of [...(pod.initContainers || []), ...pod.containers]) {
        for (const mount of participant.volumeMounts || []) {
          if (mount.name !== 'unused-native') continue;
          assert.equal(participant.image, policy.image, 'Other containers cannot write native masks');
          assert.equal(mount.readOnly, true);
          assert.ok(policy.maskedNativeDirectories.includes(mount.mountPath));
        }
      }
    }
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
      if (policy.maskedNativeDirectories) {
        assert.deepEqual(pod.volumes.find(v => v.name === 'unused-native'), {name: 'unused-native', emptyDir: {sizeLimit: '1Mi'}});
      }
      assert.deepEqual(container.volumeMounts, [
        {name: 'models', mountPath: '/models', readOnly: true},
        {name: 'tmp', mountPath: '/tmp'},
        {name: 'shm', mountPath: '/dev/shm'},
        {name: 'vllm-audio', mountPath: '/opt/videoq-audio', readOnly: true},
        ...(policy.maskedNativeDirectories || []).map(mountPath => ({name: 'unused-native', mountPath, readOnly: true})),
      ]);
      assert.deepEqual(pod.volumes.find(v => v.name === 'tmp'), {name: 'tmp', emptyDir: {sizeLimit: '4Gi'}});
    }
  }
  assert.ok(servers > 0, 'No assessed vLLM servers rendered');
}

function verifyKernelReview(policy, files) {
  const reference = policy.kernelAffectedFileReview;
  assert.equal(reference.file, 'kernel-20261126-review.json');
  const bytes = readFileSync(join(__dirname, '../../apps/inference/vllm/security', reference.file));
  assert.equal(checksum(bytes), reference.sha256);
  const evidence = JSON.parse(bytes);
  assert.equal(evidence.image, policy.image);
  assert.equal(evidence.inventorySha256, policy.kernelHeaderInventorySha256);
  assert.equal(evidence.rows.length, reference.count);
  assert.equal(reference.count, 75);
  assert.equal(new Set(evidence.rows.map(row => row.cve)).size, reference.count);
  assert.deepEqual(files, [...evidence.inventoryFiles].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = new Set(files.map(file => file.path));
  for (const row of evidence.rows) {
    assert.equal(checksum(row.primaryRecord), row.primarySha256);
    assert.equal(row.primaryUrl, `https://raw.githubusercontent.com/CVEProject/cvelistV5/${evidence.sourceCommit}/cves/2026/${row.cve.split('-')[2].slice(0, -3)}xxx/${row.cve}.json`);
    assert.match(evidence.sourceCommit, /^[a-f0-9]{40}$/);
    const record = JSON.parse(row.primaryRecord);
    assert.equal(record.cveMetadata.cveId, row.cve);
    assert.equal(record.cveMetadata.state, 'PUBLISHED');
    const affected = [...new Set(record.containers.cna.affected.flatMap(product => product.programFiles || []))].sort();
    assert.deepEqual(affected, row.affectedFiles);
    assert.ok(affected.length);
    assert.equal(row.classification, 'kernel_implementation_absent_from_user_space_header_package');
    assert.equal(row.package, 'linux-libc-dev');
    assert.equal(row.version, policy.osPackages['linux-libc-dev']);
    assert.equal(row.normalizedPurl, `pkg:deb/ubuntu/linux-libc-dev@${row.version}?arch=amd64&distro=ubuntu-24.04`);
    // Keep original scanner identity alongside the deliberately derived PURL.
    assert.equal(row.rawGrypePurl, row.normalizedPurl + '&upstream=linux');
    for (const path of affected) {
      assert.match(path, /^(?:arch|drivers|fs|include|mm|net|sound|virt|Documentation)\//);
      assert.ok(!path.includes('..') && !path.includes('/uapi/'));
      assert.ok(!paths.has('/usr/include/' + path));
      if (path.startsWith('include/')) assert.ok(!paths.has('/usr/include/' + path.slice(8)));
    }
  }
  return evidence.rows;
}

const maskedFfmpegCves = Object.freeze(['135736', '135742', '135743', '135739', '135722', '135725', '135734', '135740', '135737', '135738', '135723'].map(id => 'CVE-2026-' + id));
function verifyMaskedFfmpegReview(policy, report, native, runtime) {
  const reference = policy.maskedFfmpegReview;
  assert.equal(reference?.file, 'masked-ffmpeg-20261126-review.json');
  assert.equal(reference.count, 11);
  const bytes = readFileSync(join(__dirname, '../../apps/inference/vllm/security', reference.file));
  assert.equal(checksum(bytes), reference.sha256);
  const evidence = JSON.parse(bytes);
  assert.equal(evidence.image, policy.image);
  assert.equal(evidence.platform, 'linux/amd64');
  assert.equal(report.Metadata.ImageConfig.architecture, 'amd64');
  assert.equal(report.Metadata.ImageConfig.os, 'linux');
  assert.equal(evidence.probeSourceSha256, policy.runtimeProbeSourceSha256);
  assert.equal(evidence.inventoryProbeSourceSha256, policy.inventoryProbeSourceSha256);
  assert.equal(checksum(readFileSync(join(__dirname, 'check-vllm-runtime.py'))), evidence.probeSourceSha256);
  assert.equal(checksum(readFileSync(join(__dirname, 'check-vllm-inventory.py'))), evidence.inventoryProbeSourceSha256);
  assert.equal(native.status, 'passed');
  assert.deepEqual(native.inventory, evidence.nativeInventory);
  assert.equal(runtime?.status, 'passed');
  // Pin the complete actual check set, including source/member hashes,
  // normalized auto waveforms, flushed references, all staged mappings and
  // namespace/absolute-load denials. A copied JSON file is not authentication:
  // the caller must obtain it from the trusted native workflow artifact.
  assert.deepEqual(runtime.checks, evidence.requiredRuntimeChecks);
  assert.equal(evidence.rows.length, 11);
  assert.equal(new Set(evidence.rows.map(row => row.cve)).size, 11);
  const group = policy.groups.find(group => group.exactFindingReview);
  assert.deepEqual(group.exactFindingReview, maskedFfmpegCves);
  assert.deepEqual(evidence.rows.map(row => row.cve), maskedFfmpegCves);
  const denial = runtime.checks['security.maskedNativeDenial'].details;
  const boundary = runtime.checks['security.servingAudioBoundary'].details;
  assert.deepEqual(runtime.checks['security.maskedNative'].details, nativeMasks);
  assert.equal(boundary.nativeFilterTraceComplete, false);
  assert.deepEqual(boundary.loadedFfmpegLibraries, denial.loadedFfmpeg);
  assert.equal(denial.loadedFfmpeg.length, 7);
  assert.ok(Object.values(boundary.diagnosticImportMaps).every(paths =>
    JSON.stringify(paths) === JSON.stringify(denial.loadedFfmpeg)));
  for (const path of denial.loadedFfmpeg) {
    assert.ok(path.startsWith('/opt/videoq-audio/'));
    assert.match(boundary.pyavWheelMembers[path.slice('/opt/videoq-audio/'.length)], /^[a-f0-9]{64}$/);
  }
  for (const row of evidence.rows) {
    assert.equal(row.package, 'ffmpeg');
    assert.equal(row.version, '8.1.1');
    assert.equal(row.purl, 'pkg:generic/ffmpeg@8.1.1');
    assert.equal(checksum(row.primaryRecord), row.primarySha256);
    const record = JSON.parse(row.primaryRecord);
    assert.equal(record.cveMetadata.cveId, row.cve);
    assert.equal(record.cveMetadata.state, 'PUBLISHED');
    assert.equal(row.primaryUrl, `https://raw.githubusercontent.com/CVEProject/cvelistV5/7e4de3c1bcb5d5a1818ac5b96c2cf5370cad98b8/cves/2026/135xxx/${row.cve}.json`);
    assert.equal(row.locations.length, 26);
    assert.deepEqual([...row.locations].sort(), [...denial.absoluteLoadsDenied].sort());
    assert.ok(row.locations.every(path => nativeMasks.slice(0, 2).some(mask => path.startsWith(mask + '/'))));
  }
  return evidence.rows;
}

function assess(report, policy, native, profiles, now = new Date(), runtime) {
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
  assert.equal(new Set(files.map(file => file.path)).size, files.length);
  for (const file of files) {
    assert.ok((file.path.startsWith('/usr/include/') && file.path.endsWith('.h')) || file.path.startsWith('/usr/share/doc/linux-libc-dev/'));
    assert.ok(!file.path.includes('..'));
    assert.ok(Number.isSafeInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777 && !(file.mode & 0o111));
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  const kernelRows = policy.kernelAffectedFileReview ? verifyKernelReview(policy, files) : [];
  assert.equal(actual.pipVendor.sha256, policy.pipVendorBomSha256);
  for (const [name, version] of Object.entries(policy.runtimePython)) {
    assert.equal(actual.python[name].version, version);
    assert.ok(actual.python[name].modulePath.startsWith('/usr/local/lib/python3.12/dist-packages/'));
    assert.ok(!actual.python[name].modulePath.includes('/pip/_vendor/'));
  }
  assert.equal(profiles.length, 10, 'Review all five NVIDIA profiles before and after offline provisioning');
  profiles.forEach(documents => verifyWorkload(documents, policy));
  const accepted = [], blocking = [];
  let maskedFfmpegRows;
  for (const result of report.Results) {
    assert.ok(!result.ModifiedFindings?.length && !result.ExperimentalModifiedFindings?.length, 'Use unsuppressed raw findings');
    for (const finding of result.Vulnerabilities || []) {
      if (!['HIGH', 'CRITICAL', 'UNKNOWN'].includes(finding.Severity)) continue;
      const group = policy.groups.find(group => group.type === result.Type && group.vulnerabilities.some(id => [finding.VulnerabilityID, ...(finding.Aliases || [])].includes(id))
        && group.packages[finding.PkgName]?.version === finding.InstalledVersion
        && group.packages[finding.PkgName]?.purl === finding.PkgIdentifier?.PURL);
      if (group) {
        assert.equal(group.status, 'not_affected');
        assert.ok(group.impactStatement && group.references.length);
        assert.ok(['kernel-headers', 'unused-tools', 'openssl-unused-protocol', 'pip-vendor', 'runtime-overlay', 'masked-native', 'kernel-headers-exact-files'].includes(group.origin));
      }
      if (group?.origin === 'kernel-headers-exact-files') {
        const row = kernelRows.find(row => row.cve === finding.VulnerabilityID);
        assert.ok(row, 'Exact primary CVE evidence required; aliases cannot extend this review');
        assert.equal(finding.PkgName, row.package);
        assert.equal(finding.InstalledVersion, row.version);
        assert.equal(finding.PkgIdentifier.PURL, row.normalizedPurl);
        assert.deepEqual([...finding.Locations].sort(), row.locations);
      }
      if (group && maskedFfmpegCves.some(id => [finding.VulnerabilityID, ...(finding.Aliases || [])].includes(id))) {
        maskedFfmpegRows ||= verifyMaskedFfmpegReview(policy, report, native, runtime);
        const row = maskedFfmpegRows.find(row => row.cve === finding.VulnerabilityID);
        assert.ok(row, 'Exact reviewed CVE required; aliases cannot extend masked-library review');
        assert.equal(finding.PkgName, row.package);
        assert.equal(finding.InstalledVersion, row.version);
        assert.equal(finding.PkgIdentifier.PURL, row.purl);
        assert.deepEqual([...finding.Locations].sort(), [...row.locations].sort());
      }
      if (group?.origin === 'masked-native') {
        assert.equal(runtime?.status, 'passed');
        assert.equal(runtime.checks?.['security.maskedNative']?.status, 'passed');
        assert.deepEqual(runtime.checks['security.maskedNative'].details, policy.maskedNativeDirectories);
        assert.deepEqual([...finding.Locations].sort(), [...group.packages[finding.PkgName].locations].sort());
        assert.ok(finding.Locations.length && finding.Locations.every(path => policy.maskedNativeDirectories.some(directory => path.startsWith(directory + '/'))));
      }
      if (group?.origin === 'pip-vendor') {
        const packages = (result.Packages || []).filter(p => p.Identifier?.PURL === finding.PkgIdentifier.PURL);
        assert.ok(packages.length && packages.every(p => p.AnalyzedBy === 'sbom'), 'A reviewed pip-vendor finding also matches installed runtime metadata');
      }
      if (group?.origin === 'runtime-overlay') {
        // Retain the vulnerable base-image finding. Accept only when the actual
        // image + locked read-only overlay probe proves the patched import path.
        assert.equal(runtime?.status, 'passed', 'Missing successful actual-image runtime probe');
        assert.equal(runtime.checks?.audioLock?.status, 'passed');
        assert.equal(runtime.checks.audioLock.details, policy.audioLockSha256);
        const replacement = group.replacement;
        assert.equal(replacement?.name, finding.PkgName);
        const proof = runtime.checks?.[replacement.check];
        assert.equal(proof?.status, 'passed');
        assert.equal(proof.details.version, replacement.version);
        assert.equal(proof.details.modulePath, replacement.modulePath);
        assert.ok(replacement.modulePath.startsWith('/opt/videoq-audio/') && !replacement.modulePath.includes('..'));
        assert.equal(proof.details.oversizedWksRejected, true);
      }
      (group ? accepted : blocking).push(finding);
    }
  }
  return {image: policy.image, reviewedAt: policy.reviewedAt, expiresAt: policy.expiresAt, scope: policy.scope, accepted, blocking};
}
module.exports = {assess, verifyWorkload, verifyKernelReview, nativeMasks, verifyMaskedFfmpegReview};
