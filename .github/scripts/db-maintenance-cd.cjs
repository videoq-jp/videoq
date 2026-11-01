// Called only after successful push CI and current canonical-main validation.
const {execFileSync} = require('node:child_process');
function relevant(path) {
  if (path.startsWith('infra/db-maintenance/')) return !path.endsWith('.md');
  if (path.startsWith('.github/operations-tools/')) return true;
  if (path.startsWith('apps/demo-video/public/lessons/')) return true;
  if (path === 'apps/demo-video/content/course.json' || path === 'infra/sql/neon-security.sql') return true;
  if (['.github/workflows/db-maintenance-cd.yml', '.github/actions/aws-db-invocation/action.yml',
    '.github/scripts/run-aws-db.py', '.github/scripts/db-maintenance-cd.cjs'].includes(path)) return true;
  return /^\.github\/scripts\/(neon-(admin|policy)\.cjs|neon-profiles\.json|with-neon-credentials\.py|production-(smoke\.mjs|smoke-policy\.cjs|stream-proof\.cjs)|backup-restore\.mjs|provision-public-demo\.mjs|public-demo-policy\.cjs)$/.test(path);
}
async function selected({github, context, git = args => execFileSync('git', args, {encoding:'utf8'}).trim()}) {
  const {data} = await github.rest.actions.listWorkflowRuns({...context.repo,
    workflow_id:'db-maintenance-cd.yml',branch:'main',status:'completed',per_page:100});
  const previous = data.workflow_runs.find(run => run.conclusion === 'success' &&
    run.head_branch === 'main' && run.id !== context.runId);
  if (!previous) return true;
  if (!/^[a-f0-9]{40}$/.test(previous.head_sha)) throw new Error('INVALID_PREVIOUS_DEPLOYMENT');
  return git(['diff','--name-only',previous.head_sha,context.sha]).split('\n').some(relevant);
}
module.exports = {relevant, selected};
