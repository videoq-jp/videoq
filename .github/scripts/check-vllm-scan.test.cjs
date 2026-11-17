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

test('runtime volume scan must match the lock, receipt, directory and all five installed versions', () => {
  const {inspectAudio} = require('./check-vllm-scan.cjs');
  const {createHash} = require('node:crypto');
  const manifest = {image: reference, packages: ['av', 'scipy', 'soundfile', 'soxr', 'dnspython'].map(name => ({name, version: '1.0'}))};
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


test('audio applicability requires the verified guard, exact library identity and locations', () => {
  const {assessAudioRuntime} = require('./check-vllm-scan.cjs');
  const finding = {VulnerabilityID: 'CVE-reviewed', PkgName: 'ffmpeg', InstalledVersion: '9.0.2',
    PkgIdentifier: {PURL: 'pkg:generic/ffmpeg@9.0.2'}, Locations: ['/av.libs/libavformat-reviewed.so']};
  const policy = {audioGuardSha256: 'reviewed-guard', audioAssessments: [{vulnerability: 'CVE-reviewed',
    package: 'ffmpeg', version: '9.0.2', purl: 'pkg:generic/ffmpeg@9.0.2', locations: finding.Locations,
    impactStatement: 'Verified startup guard rejects network inputs', references: ['review']}]};
  const runtime = {status: 'passed', checks: {'security.audio': {status: 'passed',
    details: {guardSha256: 'reviewed-guard', rtspRejected: true}}}};
  const evaluate = (value = finding, proof = runtime) => assessAudioRuntime({blocking: [structuredClone(value)]}, policy, proof);
  assert.equal(evaluate().accepted.length, 1);
  for (const mutate of [value => value.VulnerabilityID = 'CVE-new', value => value.InstalledVersion = '8.1.1',
    value => value.PkgIdentifier.PURL = 'unreviewed', value => value.Locations = ['/unreviewed/library.so']]) {
    const copy = structuredClone(finding); mutate(copy); assert.equal(evaluate(copy).blocking.length, 1);
  }
  for (const mutate of [value => value.status = 'failed', value => value.checks['security.audio'].status = 'failed',
    value => value.checks['security.audio'].details.guardSha256 = 'tampered',
    value => value.checks['security.audio'].details.rtspRejected = false]) {
    const copy = structuredClone(runtime); mutate(copy); assert.throws(() => evaluate(finding, copy));
  }
});
