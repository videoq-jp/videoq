const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { assess } = require('./onprem-llamacpp-security.cjs');
const policy = JSON.parse(readFileSync(join(__dirname, '../../apps/inference/llamacpp/security/apt-runtime-assessment.json')));
const now = new Date('2026-11-05T12:00:00Z');

// Fields from the raw Ubuntu 24.04 report produced by the merge-queue scan.
function sample(architecture = 'amd64') {
  const report = {
    SchemaVersion: 2, ArtifactType: 'container_image',
    Metadata: { OS: { Family: 'ubuntu', Name: '24.04' }, RepoDigests: [policy.image],
      ImageConfig: { architecture, os: 'linux', config: {
        Entrypoint: ['/app/llama-server'],
        Labels: { 'org.opencontainers.image.revision': policy.sourceRevision },
      } } },
    Results: [{ Type: 'ubuntu', Class: 'os-pkgs', Vulnerabilities: Object.entries(policy.packages).map(([name, version]) => ({
      VulnerabilityID: 'CVE-2026-109518', PkgName: name, InstalledVersion: version, Severity: 'HIGH',
      PkgIdentifier: { PURL: `pkg:deb/ubuntu/${name}@${version}?arch=${architecture}&distro=ubuntu-24.04` },
    })) }],
  };
  const profiles = Array.from({ length: 3 }, () => ['chat', 'embedding'].map(name => ({
    kind: 'Deployment', spec: { template: { spec: {
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 10001 },
      initContainers: [{ image: 'different-provisioner@sha256:reviewed' }],
      containers: [{ name, image: policy.image,
        args: ['--model', '/models/' + 'a'.repeat(40) + '/model.gguf', '--offline'],
        env: [{ name: 'HF_HUB_OFFLINE', value: '1' }],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        volumeMounts: [{ name: 'models', mountPath: '/models', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }],
      }],
      volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '256Mi' } }],
    } } },
  })));
  return { report, profiles, architecture };
}

function run(s, overrides = {}) {
  return assess(s.report, { ...policy, ...overrides }, s.architecture, s.profiles, now);
}

test('the two APT findings remain visible with a scoped runtime assessment on both architectures', () => {
  for (const architecture of ['amd64', 'arm64']) {
    const result = run(sample(architecture));
    assert.equal(result.accepted.length, 2);
    assert.equal(result.blocking.length, 0);
    assert.equal(result.status, 'not_affected');
    assert.equal(result.expiresAt, policy.expiresAt);
    assert.ok(result.impactStatement.includes('APT remains vulnerable'));
  }
});

test('a new CVE, package, version or missing package identity still blocks promotion', () => {
  for (const change of [
    f => { f.VulnerabilityID = 'CVE-2099-0001'; },
    f => { f.PkgName = 'curl'; },
    f => { f.InstalledVersion = '2.8.4'; },
    f => { delete f.PkgIdentifier; },
    f => { f.PkgIdentifier.PURL = f.PkgIdentifier.PURL.replace('amd64', 'arm64'); },
  ]) {
    const s = sample();
    change(s.report.Results[0].Vulnerabilities[0]);
    assert.equal(run(s).blocking.length, 1);
  }
  const s = sample();
  s.report.Results[0].Vulnerabilities.push({ VulnerabilityID: 'CVE-2099-0002', Severity: 'UNKNOWN' });
  assert.equal(run(s).blocking.length, 1);
});

test('expired, future or excessively long assessments are rejected', () => {
  for (const dates of [
    { expiresAt: now.toISOString() },
    { reviewedAt: '2026-11-06T00:00:00Z' },
    { expiresAt: '2027-01-01T00:00:00Z' },
    { expiresAt: 'invalid' },
  ]) assert.throws(() => run(sample(), dates));
});

test('different images, startup programs and incomplete or pre-filtered reports are rejected', () => {
  for (const change of [
    r => { r.Metadata.RepoDigests = ['other@sha256:unreviewed']; },
    r => { r.Metadata.OS.Name = '22.04'; },
    r => { r.Metadata.ImageConfig.architecture = 'arm64'; },
    r => { r.Metadata.ImageConfig.config.Entrypoint = ['/bin/sh']; },
    r => { r.Metadata.ImageConfig.config.Cmd = ['apt-get', 'update']; },
    r => { r.Metadata.ImageConfig.config.Labels['org.opencontainers.image.revision'] = 'other'; },
    r => { r.Results = []; },
    r => { r.Results[0].ModifiedFindings = [{ Type: 'vex' }]; },
  ]) {
    const s = sample(); change(s.report);
    assert.throws(() => run(s));
  }
});

test('changing the assessed deployment security or invoking a startup shell invalidates the assessment', () => {
  for (const change of [
    p => { p.securityContext.runAsUser = 0; },
    p => { p.automountServiceAccountToken = true; },
    p => { p.initContainers[0].image = policy.image; },
    p => { p.containers[0].command = ['sh', '-c', 'apt-get update; /app/llama-server']; },
    p => { p.containers[0].lifecycle = { postStart: { exec: { command: ['apt-get', 'update'] } } }; },
    p => { p.containers[0].securityContext.readOnlyRootFilesystem = false; },
    p => { p.containers[0].securityContext.capabilities.drop = []; },
    p => { p.containers[0].env.push({ name: 'LD_PRELOAD', value: '/models/override.so' }); },
    p => { p.containers[0].volumeMounts[0].readOnly = false; },
    p => { p.containers[0].volumeMounts.push({ name: 'host', mountPath: '/usr' }); },
    p => { p.containers[0].args.push('--model-url', 'https://example.com/model'); },
  ]) {
    const s = sample(); change(s.profiles[1][0].spec.template.spec);
    assert.throws(() => run(s));
  }
  const s = sample(); s.profiles.pop();
  assert.throws(() => run(s));
});
