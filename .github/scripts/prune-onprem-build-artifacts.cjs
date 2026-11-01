const assert = require('node:assert/strict');

// These archives have a single consumer: the publish matrix. Run only after
// every image has been published and attested. Retain signed release evidence.
module.exports = async function pruneBuildArtifacts({ github, context, sourceSha }) {
  const { owner, repo } = context.repo;
  assert.equal(`${owner}/${repo}`, 'videoq-jp/videoq');
  assert.equal(context.ref, 'refs/heads/main');
  assert.ok(['workflow_dispatch', 'workflow_run'].includes(context.eventName));
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(sourceSha, context.sha);
  const runId = Number(context.runId), attempt = Number(context.runAttempt);
  assert.ok(Number.isSafeInteger(runId) && runId > 0);
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0);
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  assert.equal(run.id, runId);
  assert.equal(run.path, '.github/workflows/onprem-release.yml');
  assert.equal(run.head_sha, sourceSha);
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_repository.full_name, `${owner}/${repo}`);
  assert.equal(run.run_attempt, attempt);
  const names = new Set(['api', 'worker', 'web', 'transcription-gateway'].flatMap(component =>
    ['amd64', 'arm64'].map(arch =>
      `build-${component}-${arch}-${sourceSha}-attempt-${attempt}`)));
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: runId, per_page: 100 });
  const selected = artifacts.filter(artifact => names.has(artifact.name) && !artifact.expired);
  // Validate the complete batch before the first irreversible request.
  for (const artifact of selected) {
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
    assert.equal(artifact.workflow_run.id, runId);
    assert.equal(artifact.workflow_run.head_sha, sourceSha);
  }
  for (const artifact of selected) await github.rest.actions.deleteArtifact({ owner, repo, artifact_id: artifact.id });
  return { deleted: selected.length, bytes: selected.reduce((sum, artifact) => sum + artifact.size_in_bytes, 0) };
};
