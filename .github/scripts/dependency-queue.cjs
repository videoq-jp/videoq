// Trusted metadata and provenance helpers. Scheduling belongs to GitHub Merge Queue.
const policy = require('./dependency-automation.cjs');
const sync = require('./dependency-rebase.cjs');
const REPO = 'videoq-jp/videoq';
const BOT = process.env.DEPENDENCY_BOT_LOGIN || 'videoq-dependency-bot[bot]';
const REQUIRED = ['CI Success', 'Supply Chain Security', 'Container Validation', 'Terraform Plan'];
const sha = s => /^[a-f0-9]{40}$/.test(s || '');
function managed(pr) {
  return pr.base?.ref === 'main' && pr.head?.repo?.full_name === REPO &&
    (pr.user?.login === 'dependabot[bot]' || (pr.user?.login === BOT && /^runtime\/(node|python|npm|pip|uv)-(current|next)$/.test(pr.head.ref)));
}
async function verified({ github, context, pr, base }) {
  const pull = await policy.getPull({ github, context, number: pr.number });
  const commits = await github.paginate(github.rest.pulls.listCommits, { ...context.repo, pull_number: pr.number, per_page: 100 });
  if (!commits.length || commits.at(-1).sha !== pull.pr.head.sha) return null;
  if (pr.user.login === BOT) {
    const proof = await require('./runtime-repair-provenance.cjs').provenance({ github, context, ...pull, commits, bot: BOT, base });
    if (!proof) return null;
    return { ...pull, kind: 'runtime', runtime: proof.publication.runtime, proof,
      autoQueue: proof.publication.channel === 'current' && process.env.RUNTIME_AUTOMERGE_ENABLED !== 'false' };
  }
  const sourceFile = require('./claude-dependency-repair.cjs').sourceFile;
  if (pull.pr.labels.some(l => l.name === 'no-rebase') || !policy.eligiblePull(pull.pr, pull.files.filter(f => !sourceFile(f.filename)), 'no-automerge', pull.comments)) return null;
  const proof = await sync.provenance({ github, context, ...pull, commits });
  if (!proof) return null;
  const original = proof.originalCommits || commits;
  const seedHead = policy.verifiedDependencyCommits(original, proof.originalHead) ? proof.originalHead : undefined;
  return { ...pull, kind: 'dependabot', ...proof, seedHead };
}
async function runs({ github, context, pr }) {
  const workflow_id = 'ci.yml';
  const { data } = await github.rest.actions.listWorkflowRuns({ ...context.repo, workflow_id, head_sha: pr.head.sha, event: 'pull_request', per_page: 100 });
  const run = data.workflow_runs.sort((a, b) => b.id - a.id)[0];
  if (!run) return [{ workflow_id }];
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...context.repo, run_id: run.id, filter: 'latest', per_page: 100 });
  const admitted = REQUIRED.every(name => jobs.some(job => job.name === name && job.conclusion !== 'skipped'));
  return [{ workflow_id, run, admitted }];
}
function result(rows) {
  if (!rows.length) return 'waiting';
  if (rows.some(r => r.admitted && r.run?.status === 'completed' && ['failure', 'cancelled', 'timed_out', 'action_required'].includes(r.run.conclusion))) return 'failure';
  if (rows.every(r => r.admitted && r.run?.status === 'completed' && r.run.conclusion === 'success')) return 'success';
  return 'waiting';
}
async function repairFailure({ github, writerGithub, context, runId, mode, number, baseSha }) {
  const repair = require('./claude-dependency-repair.cjs');
  const c = await repair.scope({ github, writerGithub, context, runId, mode, number, baseSha });
  if (!c) return null;
  try {
    await github.rest.actions.createWorkflowDispatch({ ...context.repo, workflow_id: 'claude-dependency-worker.yml', ref: 'main',
      inputs: { number: String(c.number), sha: c.sha, run_id: String(runId || ''), authorization_run: String(context.runId),
        ...(c.mode === 'conflict' ? { mode: 'conflict', base_sha: c.baseSha } : {}) } });
  } catch (error) {
    await github.rest.issues.createComment({ ...context.repo, issue_number: c.number,
      body: `Claude修正ジョブを起動できませんでした。実行ログ: https://github.com/${REPO}/actions/runs/${context.runId}` });
    throw error;
  }
  return c;
}
module.exports = { managed, verified, runs, result, repairFailure };
