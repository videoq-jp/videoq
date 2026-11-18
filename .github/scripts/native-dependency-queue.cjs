// Trusted-main metadata controller. GitHub owns scheduling and main integration.
const queue = require('./dependency-queue.cjs');
const repair = require('./claude-dependency-repair.cjs');
const REPO = 'videoq-jp/videoq';
const BOT = process.env.DEPENDENCY_BOT_LOGIN || 'videoq-dependency-bot[bot]';
const REQUIRED = ['CI Success', 'Supply Chain Security', 'Terraform Plan', 'Container Validation'];
const MARKER = '<!-- videoq-native-queue-v1 -->';
function records(comments) {
  return comments.filter(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(MARKER + '\n'))
    .flatMap(comment => { try { return [JSON.parse(comment.body.split('\n')[1])]; } catch { return []; } });
}
async function record(github, context, number, value, text) {
  await github.rest.issues.createComment({ ...context.repo, issue_number: number,
    body: `${MARKER}\n${JSON.stringify(value)}\n\n${text}` });
}
async function entry(writerGithub, context, number) {
  const data = await writerGithub.graphql(
    'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{id enqueuer{__typename login}}}}}',
    { owner: context.repo.owner, name: context.repo.repo, number });
  return data.repository.pullRequest.mergeQueueEntry;
}
async function cancel(writerGithub, context, pr) {
  const queued = await entry(writerGithub, context, pr.number);
  // Automatic eligibility must not revoke a maintainer's manual queue decision
  // for a major update or a PR intentionally handled outside automation.
  const enqueuer = queued?.enqueuer;
  const automatic = enqueuer?.__typename === 'Bot' && `${enqueuer.login.replace(/\[bot\]$/, '')}[bot]` === BOT;
  if (automatic) await writerGithub.graphql(
    'mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}', { id: pr.node_id });
  if (pr.auto_merge?.enabled_by?.login === BOT) await writerGithub.graphql(
    'mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}', { id: pr.node_id });
}

function requireProtection(protection, rules) {
  const checks = protection.required_status_checks?.checks || [];
  const native = rules.find(rule => rule.type === 'merge_queue');
  if (REQUIRED.some(name => !checks.some(check => check.context === name && check.app_id === 15368)) ||
      protection.enforce_admins?.enabled !== true || protection.required_status_checks?.strict !== false ||
      !native || native.parameters?.max_entries_to_build !== 1 || native.parameters?.max_entries_to_merge !== 1 ||
      native.parameters?.merge_method !== 'MERGE') {
    throw new Error('Native automation requires protected main, all four Actions checks and a single-entry native queue.');
  }
}

// A group failure is reproduced in normal PR CI before Claude can be authorized.
// Never pass a synthetic group SHA to the model or change every waiting branch.
async function reproduceGroupFailure({ github, writerGithub, context, verify = queue.verified,
  sync = require('./dependency-rebase.cjs').update }) {
  const event = context.payload?.workflow_run;
  if (context.eventName !== 'workflow_run' || !event?.id || event.event !== 'merge_group' || event.conclusion !== 'failure') return null;
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: event.id });
  if (run.event !== 'merge_group' || run.status !== 'completed' || run.conclusion !== 'failure' ||
      run.repository?.full_name !== REPO || run.head_repository?.full_name !== REPO ||
      !/^[a-f0-9]{40}$/.test(run.head_sha)) return null;
  const match = /^gh-readonly-queue\/main\/pr-([1-9][0-9]*)-[a-f0-9]+$/.exec(run.head_branch || '');
  if (!match) return null;
  const { data: workflow } = await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: 'ci.yml' });
  if (run.workflow_id !== workflow.id) return null;
  const { data: latest } = await github.rest.actions.listWorkflowRuns({
    ...context.repo, workflow_id: run.workflow_id, head_sha: run.head_sha, event: 'merge_group', per_page: 100,
  });
  const current = latest.workflow_runs.sort((a, b) => b.id - a.id)[0];
  if (current?.id !== run.id || current.run_attempt !== run.run_attempt) return null;
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(match[1]) });
  if (!queue.managed(pr) || pr.state !== 'open' || pr.draft) return null;
  const { data: main } = await github.rest.repos.getBranch({ ...context.repo, branch: 'main' });
  const candidate = await verify({ github, context, pr, base: main.commit.sha });
  if (!candidate) return null;
  const { data: ancestry } = await github.rest.repos.compareCommits({ ...context.repo, base: pr.head.sha, head: run.head_sha });
  if (ancestry.merge_base_commit?.sha !== pr.head.sha) return null;
  const history = records(candidate.comments || []);
  if (history.some(entry => entry.group === run.head_sha)) return null;
  if (history.filter(entry => entry.kind === 'reproduce').length >= 2) {
    await record(github, context, pr.number, { kind: 'stopped', sha: pr.head.sha, group: run.head_sha },
      'Merge Queueでの失敗再現が上限に達したため、自動再投入を停止しました。実行ログを確認してください。');
    return pr.number;
  }
  await record(github, context, pr.number, { kind: 'reproduce', sha: pr.head.sha, group: run.head_sha, runId: run.id },
    'Merge Queueの検査失敗を通常のPR CIで再現します。必要な場合だけこのPRを最新mainへ追従し、通常のClaude修正判定に戻します。');
  const { data: behind } = await github.rest.repos.compareCommits({ ...context.repo, base: main.commit.sha, head: pr.head.sha });
  if (behind.behind_by > 0) {
    if (candidate.kind === 'runtime') await github.rest.actions.createWorkflowDispatch({
      ...context.repo, workflow_id: 'runtime-updates.yml', ref: 'main',
      inputs: { dry_run: 'false', runtime: candidate.runtime, channel: 'current' },
    });
    else await sync({ github, writerGithub, context, number: pr.number, expectedSha: pr.head.sha });
  } else {
    const rows = await queue.runs({ github, context, pr });
    const ci = rows.find(row => row.workflow_id === 'ci.yml');
    if (ci?.run?.status === 'completed') await github.rest.actions.reRunWorkflow({ ...context.repo, run_id: ci.run.id });
  }
  return pr.number;
}

async function reconcile({ github, writerGithub, context, verify = queue.verified, evidence = queue.runs,
  repairEnabled = false, authorizeRepair = false, prepareRepair = queue.repairFailure,
  saveSummary = async () => {} }) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPO || context.ref !== 'refs/heads/main') {
    throw new Error('Native automation requires canonical main.');
  }
  const { data: protection } = await writerGithub.rest.repos.getBranchProtection({ ...context.repo, branch: 'main' });
  const { data: rules } = await writerGithub.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', { ...context.repo, branch: 'main' });
  requireProtection(protection, rules);
  const reproducing = await reproduceGroupFailure({ github, writerGithub, context, verify });
  const { data: main } = await github.rest.repos.getBranch({ ...context.repo, branch: 'main' });
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...context.repo, state: 'open', base: 'main', sort: 'created', direction: 'asc', per_page: 100,
  });
  const summary = [];
  let wake = false;
  for (const listed of pulls.filter(queue.managed)) {
    if (listed.number === reproducing) continue;
    const candidate = await verify({ github, context, pr: listed, base: main.commit.sha });
    const pr = candidate?.pr || (await github.rest.pulls.get({ ...context.repo, pull_number: listed.number })).data;
    if (!candidate) {
      await cancel(writerGithub, context, pr);
      summary.push(`#${pr.number}: automatic eligibility could not be verified`);
      continue;
    }
    if (pr.mergeable === false) {
      await cancel(writerGithub, context, pr);
      if (repairEnabled && ['dependabot', 'runtime'].includes(candidate.kind)) {
        if (await repair.stopIfExhausted({ github, context, pr, comments: candidate.comments || [], mode: 'conflict' })) continue;
        if (authorizeRepair) await prepareRepair({ github, writerGithub, context, mode: 'conflict', number: pr.number, baseSha: main.commit.sha });
        else wake = true;
      }
      summary.push(`#${pr.number}: automatic conflict resolution requested`);
      continue;
    }
    if (pr.mergeable === null) {
      summary.push(`#${pr.number}: GitHub is still computing mergeability`);
      continue;
    }
    if (records(candidate.comments || []).some(entry => entry.kind === 'stopped' && entry.sha === pr.head.sha)) {
      await cancel(writerGithub, context, pr);
      summary.push(`#${pr.number}: queue failure retry limit reached`);
      continue;
    }
    if (candidate.seedHead) await repair.seed({ github, context,
      pr: { ...pr, head: { ...pr.head, sha: candidate.seedHead } }, metadata: candidate.metadata });
    const rows = await evidence({ github, context, pr });
    const outcome = queue.result(rows);
    summary.push(`#${pr.number}: ${outcome}`);
    if (outcome === 'failure') {
      await cancel(writerGithub, context, pr);
      const ci = rows.find(row => row.workflow_id === 'ci.yml');
      if (!repairEnabled || !['dependabot', 'runtime'].includes(candidate.kind) || !ci?.admitted || ci.run?.conclusion !== 'failure') continue;
      const comments = candidate.comments || [];
      if (await repair.stopIfExhausted({ github, context, pr, comments })) continue;
      if (!await repair.mayAttempt({ github, context, comments, head: pr.head.sha })) continue;
      if (authorizeRepair) await prepareRepair({ github, writerGithub, context, runId: ci.run.id });
      else wake = true;
      continue;
    }
    if (outcome !== 'success') continue;
    if (candidate.autoQueue === false) {
      await cancel(writerGithub, context, pr);
      summary.push(`#${pr.number}: CI passed; manual runtime-line review required or runtime automerge disabled`);
      continue;
    }
    const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
    if (current.state !== 'open' || current.draft || current.head.sha !== pr.head.sha ||
        current.labels.some(label => ['no-automerge', 'no-runtime-update', 'no-rebase'].includes(label.name))) continue;
    if (current.mergeable === false || current.mergeable === null) continue;
    if (await entry(writerGithub, context, pr.number)) continue;
    try {
      await writerGithub.graphql(
        'mutation($id:ID!,$sha:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha}){clientMutationId}}',
        { id: current.node_id, sha: current.head.sha });
    } catch (error) {
      // Main may change between REST's mergeability result and this atomic
      // mutation. Leave that PR to the next event; do not stall later updates.
      if (!error.errors?.length || !error.errors.every(e => e.type === 'UNPROCESSABLE' &&
        /merge conflicts|not in mergeable state/i.test(e.message))) throw error;
      summary.push(`#${pr.number}: mergeability changed before enqueue; awaiting the next event`);
    }
  }
  if (wake) await github.rest.actions.createWorkflowDispatch({
    ...context.repo, workflow_id: 'dependency-queue.yml', ref: 'main',
  });
  await saveSummary(summary.join('\n') || 'No eligible automatic updates.');
  return summary;
}
module.exports = { reconcile, requireProtection, reproduceGroupFailure, records, MARKER };
