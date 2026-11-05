// Preserve raw findings; apply the runtime assessment only after checking its scope.
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');

function verifyRuntime(documents, policy) {
  const deployments = documents.filter(d => d?.kind === 'Deployment');
  const servers = [];
  for (const deployment of deployments) {
    const pod = deployment.spec.template.spec;
    for (const init of pod.initContainers || []) {
      assert.notEqual(init.image, policy.image, 'Assessed image cannot run initialization commands');
    }
    for (const container of pod.containers || []) {
      if (container.image !== policy.image) continue;
      servers.push(container.name);
      assert.ok(['chat', 'embedding'].includes(container.name));
      assert.equal(pod.automountServiceAccountToken, false);
      assert.equal(pod.hostNetwork, undefined);
      assert.equal(pod.securityContext.runAsNonRoot, true);
      assert.equal(pod.securityContext.runAsUser, 10001);
      assert.equal(container.command, undefined, 'Use the reviewed native image entrypoint');
      assert.equal(container.lifecycle, undefined, 'No additional startup commands');
      assert.equal(container.envFrom, undefined);
      assert.equal(container.securityContext.runAsUser, undefined);
      assert.equal(container.securityContext.privileged, undefined);
      assert.equal(container.securityContext.allowPrivilegeEscalation, false);
      assert.equal(container.securityContext.readOnlyRootFilesystem, true);
      assert.deepEqual(container.securityContext.capabilities, { drop: ['ALL'] });
      assert.ok(container.args.includes('--offline'));
      assert.equal(container.args[0], '--model');
      assert.match(container.args[1], /^\/models\/[a-f0-9]{40}\/[^/]+\.gguf$/);
      assert.ok(!container.args.some(a => /^(--hf-|--model-url|--rpc)/.test(a)));
      assert.equal(container.env.find(e => e.name === 'HF_HUB_OFFLINE')?.value, '1');
      assert.ok(!container.env.some(e => /^(LD_|BASH_ENV|ENV$)/.test(e.name)));
      assert.deepEqual(container.volumeMounts, [
        { name: 'models', mountPath: '/models', readOnly: true },
        { name: 'tmp', mountPath: '/tmp' },
      ]);
      assert.deepEqual(pod.volumes.find(v => v.name === 'tmp'), { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } });
    }
  }
  assert.ok(servers.includes('chat') && servers.includes('embedding'), 'Both reviewed llama.cpp servers must be rendered');
}

function assess(report, policy, architecture, profiles, now = new Date()) {
  assert.ok(policy.owner && policy.impactStatement && policy.references?.length);
  const reviewed = Date.parse(policy.reviewedAt), expires = Date.parse(policy.expiresAt);
  assert.ok(Number.isFinite(reviewed) && Number.isFinite(expires));
  assert.ok(now >= reviewed && now < expires, 'Runtime assessment expired or not yet valid');
  assert.ok(expires > reviewed && expires - reviewed <= 30 * 86400000, 'Review interval must not exceed 30 days');
  assert.equal(policy.status, 'not_affected');
  assert.equal(policy.justification, 'vulnerable_code_not_in_execute_path');
  assert.ok(policy.architectures.includes(architecture));
  assert.equal(report.SchemaVersion, 2);
  assert.equal(report.ArtifactType, 'container_image');
  assert.ok(report.Metadata.RepoDigests.includes(policy.image), 'Unreviewed image digest');
  assert.deepEqual(report.Metadata.OS, policy.os);
  const config = report.Metadata.ImageConfig;
  assert.equal(config.architecture, architecture);
  assert.equal(config.os, 'linux');
  assert.deepEqual(config.config.Entrypoint, ['/app/llama-server']);
  assert.ok(!config.config.Cmd?.length && !config.config.OnBuild?.length);
  assert.equal(config.config.Labels['org.opencontainers.image.revision'], policy.sourceRevision);
  assert.equal(profiles.length, 3, 'Check default, downloaded and pre-provisioned CPU deployments');
  profiles.forEach(documents => verifyRuntime(documents, policy));
  assert.ok(report.Results?.some(r => r.Type === 'ubuntu' && r.Class === 'os-pkgs'), 'Missing OS scan');
  const accepted = [], blocking = [];
  for (const result of report.Results) {
    assert.ok(!result.ModifiedFindings?.length, 'Use a raw scan without suppressions');
    for (const finding of result.Vulnerabilities || []) {
      if (!['HIGH', 'CRITICAL', 'UNKNOWN'].includes(finding.Severity)) continue;
      const purl = `pkg:deb/ubuntu/${finding.PkgName}@${finding.InstalledVersion}?arch=${architecture}&distro=ubuntu-24.04`;
      const inScope = result.Type === 'ubuntu' && result.Class === 'os-pkgs'
        && finding.VulnerabilityID === policy.vulnerability
        && policy.packages[finding.PkgName] === finding.InstalledVersion
        && finding.PkgIdentifier?.PURL === purl;
      (inScope ? accepted : blocking).push(finding);
    }
  }
  return { image: policy.image, architecture, assessedAt: now.toISOString(), expiresAt: policy.expiresAt,
    owner: policy.owner, status: policy.status, justification: policy.justification,
    impactStatement: policy.impactStatement, accepted, blocking };
}

function main() {
  const { parseAllDocuments, parse } = require('yaml');
  const [input, architecture, output] = process.argv.slice(2);
  assert.ok(input && architecture && output, 'Usage: onprem-llamacpp-security.cjs RAW_REPORT ARCH OUTPUT');
  const root = resolve(__dirname, '../..');
  const policy = JSON.parse(readFileSync(resolve(root, 'apps/inference/llamacpp/security/apt-runtime-assessment.json')));
  const values = parse(readFileSync(resolve(root, 'charts/videoq-inference/values.yaml'), 'utf8'));
  assert.equal(`${values.llamacpp.image.repository}@${values.llamacpp.image.digest}`, policy.image);
  for (const server of Object.values(values.servers)) assert.deepEqual(server.extraArgs, [], 'Review additional runtime arguments');
  const profiles = [[], ['-f', 'charts/videoq-inference/examples/llamacpp-cpu.yaml'],
    ['-f', 'charts/videoq-inference/examples/llamacpp-cpu.yaml', '--set', 'downloadModels=false', '--set', 'networkPolicy.denyEgress=true']]
    .map(args => parseAllDocuments(execFileSync(process.env.HELM_BIN || 'helm',
      ['template', 'assessment', 'charts/videoq-inference', ...args], { cwd: root, encoding: 'utf8' }))
      .map(d => { assert.equal(d.errors.length, 0); return d.toJSON(); }));
  const result = assess(JSON.parse(readFileSync(input)), policy, architecture, profiles);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`${result.accepted.length} explicitly assessed findings; ${result.blocking.length} blocking findings`);
  assert.equal(result.blocking.length, 0, 'Unassessed HIGH/CRITICAL/UNKNOWN findings');
}

if (require.main === module) main();
module.exports = { assess, verifyRuntime };
