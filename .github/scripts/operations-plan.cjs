// Trusted main decides which monitors may access production credentials.
const CHECKS = ['dependencies', 'containers', 'terraform', 'tokens', 'smoke', 'backup', 'onprem', 'inference'];
async function plan({ github, context, check = 'all' }) {
  if (`${context.repo.owner}/${context.repo.repo}` !== 'videoq-jp/videoq' || context.ref !== 'refs/heads/main') {
    throw new Error('Operations require canonical main.');
  }
  let selected;
  switch (context.eventName) {
    case 'schedule':
      if (context.payload.schedule === '17 0 * * *') selected = CHECKS.filter(name => !['backup', 'inference'].includes(name));
      else if (context.payload.schedule === '17 2 * * 1') selected = ['inference'];
      else if (context.payload.schedule === '41 4 1 * *') selected = ['backup'];
      else throw new Error('Unknown operations schedule.');
      break;
    case 'workflow_dispatch':
      if (check !== 'all' && !CHECKS.includes(check)) throw new Error('Unknown operations check.');
      selected = check === 'all' ? CHECKS : [check];
      break;
    case 'push': selected = ['tokens']; break;
    case 'workflow_run': {
      const run = context.payload.workflow_run;
      const { data: workflow } = await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: 'cd.yml' });
      if (run?.repository?.full_name !== 'videoq-jp/videoq' || run.head_repository?.full_name !== 'videoq-jp/videoq' ||
          run.head_branch !== 'main' || run.workflow_id !== workflow.id || run.conclusion !== 'success') {
        throw new Error('Untrusted CD event.');
      }
      const { data } = await github.rest.actions.listWorkflowRuns({ ...context.repo,
        workflow_id: workflow.id, branch: 'main', status: 'success', per_page: 1 });
      if (data.workflow_runs[0]?.id !== run.id) { selected = []; break; }
      const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({ ...context.repo,
        run_id: run.id, filter: 'latest', per_page: 100 });
      const applicationJobs = ['Deploy web (prebuilt Cloudflare artifact)',
        'Deploy api (prebuilt Cloudflare artifact)', 'Deploy prebuilt Worker Lambda image', 'Drizzle DB Migrate'];
      // A successful CD may have deployed only docs, or skipped every deployment.
      // Keep daily/manual checks, and fail conservatively if job names change.
      const known = applicationJobs.map(name => jobs.jobs.find(job => job.name === name));
      selected = known.some(job => !job || job.conclusion !== 'skipped') ? ['smoke'] : [];
      break;
    }
    default: throw new Error('Unsupported operations event.');
  }
  return Object.fromEntries(CHECKS.map(name => [name, selected.includes(name)]));
}
module.exports = { plan };
