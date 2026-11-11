// Publish only static, already verified/scanned artifacts after both rehearsal gates.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const REPO = 'videoq-jp/videoq';
const COMPONENTS = ['api', 'worker', 'web', 'transcription-gateway', 'vllm-engine'];

module.exports = async function publish({ github, context, sourceSha, runId, attempt, directory }) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPO || context.ref !== 'refs/heads/main' ||
      !['workflow_run', 'workflow_dispatch'].includes(context.eventName) || context.sha !== sourceSha ||
      !/^[a-f0-9]{40}$/.test(sourceSha) || !/^[1-9][0-9]*$/.test(String(runId)) || !/^[1-9][0-9]*$/.test(String(attempt))) {
    throw new Error('Only the validated main workflow may publish on-prem downloads');
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
  if (manifest.repository !== REPO || manifest.sourceSha !== sourceSha || manifest.schemaVersion !== 4 ||
      Object.keys(manifest.images).sort().join(',') !== [...COMPONENTS].sort().join(',')) {
    throw new Error('Unexpected public release manifest');
  }
  const names = ['release.json', `videoq-0.1.0-sha.${sourceSha}.tgz`, `videoq-inference-0.1.0-sha.${sourceSha}.tgz`,
    'release.sigstore.json', ...COMPONENTS.map(name => `${name}.sigstore.json`)];
  // Read every required input before creating a release. No payload code is executed.
  const assets = names.map(name => ({ name, data: readFileSync(join(directory, name)) }));
  if (assets.some(asset => asset.data.length === 0)) throw new Error('Empty public release asset');
  const tag = `onprem-${sourceSha}-${runId}-${attempt}`;
  try {
    await github.rest.repos.getReleaseByTag({ ...context.repo, tag });
    throw new Error('Release tag already exists; published assets must not be overwritten');
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const { data: release } = await github.rest.repos.createRelease({ ...context.repo, tag_name: tag,
    target_commitish: sourceSha, name: `VideoQ on-prem runtime ${sourceSha.slice(0, 12)}`,
    body: `Signed on-prem runtime and Helm charts. Installer downloads need no GitHub account or CLI.\n\nSource: ${sourceSha}\nBuild: https://github.com/${REPO}/actions/runs/${runId}/attempts/${attempt}\n\nVerify every Sigstore bundle against the main workflow, source revision, hosted runner and artifact digest.`,
    draft: true, prerelease: false, make_latest: 'false' });
  for (const asset of assets) {
    await github.rest.repos.uploadReleaseAsset({ ...context.repo, release_id: release.id,
      name: asset.name, data: asset.data, headers: { 'content-type': 'application/octet-stream', 'content-length': asset.data.length } });
  }
  const { data: published } = await github.rest.repos.updateRelease({ ...context.repo, release_id: release.id,
    draft: false, make_latest: 'false' });
  return published;
};
