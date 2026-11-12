// Keep every raw finding. No inherited VideoQ image VEX applies to upstream vLLM.
const assert = require('node:assert/strict');
const {readFileSync, writeFileSync} = require('node:fs');
const {createHash} = require('node:crypto');
const {resolve} = require('node:path');
function inspect(report, reference) {
  assert.match(reference, /^vllm\/vllm-openai@sha256:[a-f0-9]{64}$/);
  assert.equal(report.SchemaVersion, 2);
  assert.equal(report.ArtifactType, 'container_image');
  assert.ok(report.Metadata.RepoDigests.includes(reference), 'Scan digest must match the serving image');
  assert.equal(report.Metadata.ImageConfig.architecture, 'amd64');
  assert.equal(report.Metadata.ImageConfig.os, 'linux');
  assert.ok(report.Results.some(r => r.Class === 'os-pkgs'), 'Missing OS inventory');
  assert.ok(report.Results.some(r => r.Type === 'python-pkg' && r.Packages?.length), 'Missing Python inventory');
  const blocking = [];
  for (const result of report.Results) {
    assert.ok(!result.ModifiedFindings?.length && !result.ExperimentalModifiedFindings?.length, 'Suppressed findings are forbidden');
    for (const finding of result.Vulnerabilities || []) {
      assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'].includes(finding.Severity), 'Missing or unrecognized vulnerability severity');
      if (['HIGH', 'CRITICAL', 'UNKNOWN'].includes(finding.Severity)) blocking.push(finding);
    }
  }
  return {image: reference, blocking};
}
function inspectAudio(report, manifestBytes, receipt, reference, directory) {
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.image, reference);
  assert.equal(receipt.lockSha256, createHash('sha256').update(manifestBytes).digest('hex'));
  assert.deepEqual(receipt.manifest, manifest);
  assert.equal(report.SchemaVersion, 2);
  assert.equal(report.ArtifactType, 'filesystem');
  assert.equal(resolve(report.ArtifactName), resolve(directory), 'Scan the actual mounted audio directory');
  const packages = report.Results.filter(r => r.Type === 'python-pkg').flatMap(r => r.Packages || []);
  const expected = manifest.packages.map(p => [p.name, p.version]).sort();
  assert.deepEqual(packages.map(p => [p.Name, p.Version]).sort(), expected, 'Audio scan inventory does not match the wheel lock');
  const blocking = [];
  for (const result of report.Results) {
    assert.ok(!result.ModifiedFindings?.length && !result.ExperimentalModifiedFindings?.length, 'Suppressed audio findings are forbidden');
    for (const finding of result.Vulnerabilities || []) {
      assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'].includes(finding.Severity));
      if (['HIGH', 'CRITICAL', 'UNKNOWN'].includes(finding.Severity)) blocking.push(finding);
    }
  }
  return {lockSha256: receipt.lockSha256, packages: expected, blocking};
}
if (require.main === module) {
  const [raw, reference, output, audioRaw, lock, directory, nativeFile] = process.argv.slice(2);
  assert.ok(raw && reference && output && audioRaw && lock && directory && nativeFile,
    'Usage: check-vllm-scan.cjs IMAGE_REPORT IMAGE OUTPUT AUDIO_REPORT LOCK AUDIO_DIRECTORY NATIVE_INVENTORY');
  const report = JSON.parse(readFileSync(raw, 'utf8'));
  const result = inspect(report, reference);
  const root = resolve(__dirname, '../..');
  const policy = JSON.parse(readFileSync(resolve(root, 'apps/inference/vllm/security/runtime-assessment.json'), 'utf8'));
  assert.equal(policy.image, reference);
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, '.github/scripts/check-vllm-inventory.py'))).digest('hex'), policy.inventoryProbeSourceSha256);
  const {execFileSync} = require('node:child_process');
  const {parseAllDocuments} = require('yaml');
  const profiles = ['gpt-oss-embeddinggemma', 'vllm-nvidia', 'whisper-nvidia', 'rtx4090', 'rtx4090-gpt-oss-embeddinggemma'].flatMap(profile =>
    [[], ['--set', 'downloadModels=false', '--set', 'networkPolicy.denyEgress=true']].map(extra =>
      parseAllDocuments(execFileSync(process.env.HELM_BIN || 'helm', ['template', 'assessment', 'charts/videoq-inference',
        '-f', `charts/videoq-inference/examples/${profile}.yaml`, ...extra], {cwd: root, encoding: 'utf8'}))
        .map(document => { assert.equal(document.errors.length, 0); return document.toJSON(); }).filter(Boolean)));
  Object.assign(result, require('./check-vllm-applicability.cjs').assess(report, policy,
    JSON.parse(readFileSync(nativeFile, 'utf8')), profiles));
  result.audio = inspectAudio(JSON.parse(readFileSync(audioRaw, 'utf8')), readFileSync(lock),
    JSON.parse(readFileSync(resolve(directory, '.videoq-audio.json'), 'utf8')), reference, directory);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  assert.equal(result.blocking.length + result.audio.blocking.length, 0, 'Unassessed upstream vLLM or audio vulnerabilities');
}
module.exports = {inspect, inspectAudio};
