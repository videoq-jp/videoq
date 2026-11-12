// Loaded from the approved workflow SHA, after validate-deployment.cjs.
// Compare against a released source, not the last commit: an unreleased code
// change must still publish when the newest commit only updates documentation.
const REPOSITORY = 'videoq-jp/videoq';
const TAG = /^onprem-([a-f0-9]{40})-([1-9][0-9]*)-([1-9][0-9]*)$/;
const housekeeping = new Set([
  '.github/scripts/onprem_distribution.py',
  '.github/scripts/test_onprem_distribution.py',
  '.github/workflows/onprem-retention.yml',
]);
function operational(path) {
  return typeof path === 'string' && (path === 'README.md' ||
    path.startsWith('docs/') || path.startsWith('apps/docs/') ||
    path.startsWith('.github/deployment-pins/') || housekeeping.has(path));
}

module.exports = async function releaseNeeded({github, context, sha}) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPOSITORY || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Invalid on-prem release source');
  }
  if (context.eventName === 'workflow_dispatch') return {needed:true, reason:'Explicit main release requested'};
  if (context.eventName !== 'workflow_run') throw new Error('Unsupported release event');
  const releases = await github.paginate(github.rest.repos.listReleases, {...context.repo, per_page:100});
  const candidates = releases.filter(r => !r.draft && !r.prerelease && TAG.test(r.tag_name) &&
    Number.isFinite(Date.parse(r.published_at)) &&
    ['release.json','release.sigstore.json'].every(name => r.assets?.some(a => a.name === name)))
    .sort((a,b) => Date.parse(b.published_at)-Date.parse(a.published_at) || b.id-a.id);
  let baseline;
  for (const release of candidates) {
    const [,source,runId,attempt] = TAG.exec(release.tag_name);
    if (release.target_commitish !== source || !Number.isSafeInteger(Number(runId)) || !Number.isSafeInteger(Number(attempt))) continue;
    const {data:run} = await github.rest.actions.getWorkflowRun({...context.repo, run_id:Number(runId)});
    if (run.status === 'completed' && run.conclusion === 'success' && run.head_branch === 'main' &&
        run.head_sha === source && run.run_attempt === Number(attempt) &&
        run.path === '.github/workflows/onprem-release.yml' &&
        run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY) {
      baseline = source;
      break;
    }
  }
  if (!baseline) return {needed:true, reason:'No successful published on-prem baseline'};
  if (baseline === sha) return {needed:false, reason:'This source is already released', baseline};
  const {data:diff} = await github.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    ...context.repo, basehead:`${baseline}...${sha}`, per_page:100,
  });
  // Never skip on an unknown, divergent, large or possibly truncated diff.
  if (diff.status !== 'ahead' || !Array.isArray(diff.files) || diff.files.length >= 100 ||
      !Number.isSafeInteger(diff.total_commits) || diff.total_commits < 1 || diff.total_commits > 100) {
    return {needed:true, reason:'A complete small forward diff could not be established', baseline};
  }
  const needed = diff.files.some(f => !operational(f.filename) ||
    (f.previous_filename !== undefined && !operational(f.previous_filename)));
  return {needed, baseline, reason:needed ? 'Runtime or distribution inputs changed' :
    'Only documentation, adopted-version pins or retention housekeeping changed; retaining the existing release'};
};
