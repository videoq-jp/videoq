const {test} = require('node:test');
const assert = require('node:assert/strict');
const {inspect} = require('./check-vllm-scan.cjs');
const reference = 'vllm/vllm-openai@sha256:' + 'a'.repeat(64);
const clean = () => ({SchemaVersion: 2, ArtifactType: 'container_image',
  Metadata: {RepoDigests: [reference], ImageConfig: {architecture: 'amd64', os: 'linux'}},
  Results: [{Class: 'os-pkgs', Type: 'ubuntu'}, {Class: 'lang-pkgs', Type: 'python-pkg', Packages: [{Name: 'vllm', Version: '0.33.0'}]}]});
test('upstream findings stay blocking even when no fix exists', () => {
  for (const severity of ['HIGH', 'CRITICAL', 'UNKNOWN']) {
    const raw = clean();
    const finding = {VulnerabilityID: 'CVE-test', Severity: severity};
    raw.Results[1].Vulnerabilities = [finding];
    assert.deepEqual(inspect(raw, reference).blocking, [finding]);
  }
  assert.deepEqual(inspect(clean(), reference).blocking, []);
});
test('refuses unrelated scans, incomplete inventories and suppressed findings', () => {
  for (const mutate of [r => r.Metadata.RepoDigests = [], r => r.Metadata.ImageConfig.architecture = 'arm64',
    r => r.Results.pop(), r => r.Results.shift(), r => r.Results[1].Packages = [],
    r => r.Results[1].Vulnerabilities = [{Severity: "unrecognized"}],
    r => r.Results[1].Vulnerabilities = [{}], r => r.Results[0].ModifiedFindings = [{}],
    r => r.Results[0].ExperimentalModifiedFindings = [{}]]) {
    const raw = clean(); mutate(raw);
    assert.throws(() => inspect(raw, reference));
  }
});

test('audio scan must match the lock, receipt, directory and all four installed versions', () => {
  const {inspectAudio} = require('./check-vllm-scan.cjs');
  const {createHash} = require('node:crypto');
  const manifest = {image: reference, packages: ['av', 'scipy', 'soundfile', 'soxr'].map(name => ({name, version: '1.0'}))};
  const bytes = Buffer.from(JSON.stringify(manifest));
  const receipt = {lockSha256: createHash('sha256').update(bytes).digest('hex'), manifest};
  const raw = {SchemaVersion: 2, ArtifactType: 'filesystem', ArtifactName: '/audio', Results: [{Type: 'python-pkg',
    Packages: manifest.packages.map(p => ({Name: p.name, Version: p.version}))}]};
  assert.deepEqual(inspectAudio(raw, bytes, receipt, reference, '/audio').blocking, []);
  for (const mutate of [r => r.Results[0].Packages.pop(), r => r.Results[0].Packages[0].Version = 'different',
    r => r.ArtifactName = '/unrelated', r => r.Results[0].ModifiedFindings = [{}]]) {
    const copy = structuredClone(raw); mutate(copy);
    assert.throws(() => inspectAudio(copy, bytes, receipt, reference, '/audio'));
  }
  assert.throws(() => inspectAudio(raw, bytes, {...receipt, lockSha256: 'wrong'}, reference, '/audio'));
  raw.Results[0].Vulnerabilities = [{Severity: 'HIGH'}];
  assert.equal(inspectAudio(raw, bytes, receipt, reference, '/audio').blocking.length, 1);
});
