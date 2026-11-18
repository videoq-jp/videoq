const { Buffer: NodeBuffer } = require('node:buffer');

const FILES = new Set([
  '.github/runtime-versions.json', '.node-version', '.nvmrc', '.python-version',
  'package.json',
  'apps/api/Dockerfile', 'apps/api/Dockerfile.local', 'apps/web/Dockerfile', 'apps/web/Dockerfile.dev',
  'apps/worker/Dockerfile', 'apps/worker/Dockerfile.local', 'apps/worker/Dockerfile.onprem',
]);
const MARKER = '<!-- videoq-runtime-update-v1 -->';
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
function sameLine(plan) {
  if (!/^\d+\.\d+\.\d+$/.test(plan.previous_version || '') || !/^\d+\.\d+\.\d+$/.test(plan.version || '')) return false;
  const before = plan.previous_version.split('.').map(Number), after = plan.version.split('.').map(Number);
  const width = plan.runtime === 'python' || (plan.runtime === 'uv' && before[0] === 0) ? 2 : 1;
  const comparison = after[0] - before[0] || after[1] - before[1] || after[2] - before[2];
  return comparison >= 0 && before.slice(0, width).join('.') === after.slice(0, width).join('.');
}
function receipts(comments, bot) {
  return comments.filter(c => c.user?.login === bot && c.body?.startsWith(MARKER + '\n'))
    .flatMap(c => { try { return [JSON.parse(c.body.split('\n')[1])]; } catch { return []; } });
}
// PR commit lists can include commits brought in by an earlier main sync.
// Only branch-specific commits must belong to the publication App. Every other
// commit must be a proven ancestor of the trusted main snapshot.
async function ownedCommits({ github, context, commits, bot, base }) {
  if (!commits.length) return false;
  for (const commit of commits) {
    if (commit.author?.login === bot) continue;
    if (!sha(commit.sha)) return false;
    if (!base) base = (await github.rest.repos.getBranch({ ...context.repo, branch: 'main' })).data.commit.sha;
    if (!sha(base)) return false;
    const { data } = await github.rest.repos.compareCommits({ ...context.repo, base: commit.sha, head: base });
    if (data.merge_base_commit?.sha !== commit.sha) return false;
  }
  return true;
}
function eligible(pr, files, comments, bot, allowNext = false) {
  if (pr.state !== 'open' || pr.draft || pr.user?.login !== bot || pr.base?.ref !== 'main' ||
      pr.base.repo?.full_name !== 'videoq-jp/videoq' || pr.head.repo?.full_name !== 'videoq-jp/videoq' ||
      pr.labels.some(l => ['no-automerge', 'no-runtime-update'].includes(l.name)) || !sha(pr.head.sha) ||
      !files.length || files.length > FILES.size || files.some(f => f.status !== 'modified' || !FILES.has(f.filename))) return false;
  return receipts(comments, bot).some(r => r.sha === pr.head.sha && sha(r.base) &&
    (r.channel === 'current' || (allowNext && r.channel === 'next')) && ['node', 'python', 'npm', 'pip', 'uv'].includes(r.runtime) &&
    pr.head.ref === `runtime/${r.runtime}-${r.channel}` && (r.channel === 'next' ? /^\d+\.\d+\.\d+$/.test(r.version || '') : sameLine(r)));
}

async function scope({ context, runtime = 'all', channel = 'current' }) {
  if (context.ref !== 'refs/heads/main' || context.repo.owner !== 'videoq-jp' || context.repo.repo !== 'videoq') throw new Error('Runtime discovery requires canonical main');
  const names = ['node', 'python', 'npm', 'pip', 'uv'];
  if (!['all', ...names].includes(runtime) || !['both', 'current', 'next'].includes(channel)) throw new Error('Invalid runtime selection');
  if (!['schedule', 'workflow_dispatch'].includes(context.eventName)) throw new Error('Unsupported runtime discovery event');
  const channels = context.eventName === 'schedule' || channel === 'both' ? ['current', 'next'] : [channel];
  const include = names.filter(n => runtime === 'all' || runtime === n).flatMap(runtime => channels.map(channel => ({ runtime, channel })));
  return { matrix: { include } };
}

function validate(plan) {
  if (!plan || !['node', 'python', 'npm', 'pip', 'uv'].includes(plan.runtime) ||
      !['current', 'next'].includes(plan.channel) ||
      !/^\d+\.\d+\.\d+$/.test(plan.version) ||
      !plan.files || typeof plan.files !== 'object' || Array.isArray(plan.files) ||
      Object.entries(plan.files).some(([name, content]) => !FILES.has(name) ||
        typeof content !== 'string' || NodeBuffer.byteLength(content) > 200_000) ||
      plan.changed !== (Object.keys(plan.files).length > 0) ||
      (plan.channel === 'current' && plan.previous_version !== undefined && !sameLine(plan))) {
    throw new Error('Invalid interpreter update plan');
  }
}

async function publish({ github, context, core, plan, bot, retireSuperseded = false }) {
  validate(plan);
  if (context.ref !== 'refs/heads/main' || !['schedule', 'workflow_dispatch'].includes(context.eventName) ||
      context.repo.repo !== 'videoq' ||
      context.repo.owner !== 'videoq-jp' || !/^[a-zA-Z0-9-]+\[bot\]$/.test(bot)) {
    throw new Error('Interpreter updates require the trusted repository main branch and an App token');
  }
  const { data: base } = await github.rest.git.getRef({ ...context.repo, ref: 'heads/main' });
  if (base.object.sha !== context.sha) throw new Error('Main changed; rerun discovery against the current commit');
  const branch = `runtime/${plan.runtime}-${plan.channel}`;
  const { data: pulls } = await github.rest.pulls.list({ ...context.repo, state: 'open', base: 'main', head: `${context.repo.owner}:${branch}` });
  if (pulls.length > 1) throw new Error('Ambiguous interpreter update PR');
  const existing = pulls[0];
  if (!plan.changed && !existing) return;
  let managed = existing;
  let old;
  try {
    old = (await github.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` })).data.object.sha;
  } catch (error) { if (error.status !== 404) throw error; }
  if (old) {
    if (!managed) {
      const { data: closed } = await github.rest.pulls.list({ ...context.repo, state: 'closed', base: 'main', head: `${context.repo.owner}:${branch}` });
      for (const pr of closed.filter(pr => pr.user.login === bot && pr.head.sha === old)) {
        if (pr.merged_at) { managed = pr; break; }
        const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: pr.number, per_page: 100 });
        if (receipts(comments, bot).some(r => r.kind === 'superseded' && r.sha === old && r.runtime === plan.runtime && r.channel === plan.channel)) {
          managed = pr; break;
        }
        // A maintainer-closed proposal is an intentional opt-out. Preserve its
        // branch (including human follow-ups) without failing daily discovery.
        core.info(`Runtime PR #${pr.number} was manually closed; preserving its branch without proposing again`);
        return pr.number;
      }
    }
    if (!managed || managed.user.login !== bot || managed.head.sha !== old) {
      throw new Error('Refusing to overwrite an unmanaged runtime branch');
    }
    const commits = await github.paginate(github.rest.pulls.listCommits, { ...context.repo, pull_number: managed.number, per_page: 100 });
    if (!await ownedCommits({ github, context, commits, bot, base: base.object.sha })) {
      throw new Error('Runtime PR has human changes; preserve them for review');
    }
    const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: managed.number, per_page: 100 });
    const publication = receipts(comments, bot).find(r => r.kind !== 'superseded' && r.sha === old && r.runtime === plan.runtime && r.channel === plan.channel);
    if (!publication && existing && require('./claude-dependency-repair.cjs').records(comments, 'published').some(r => r.sha === old) && await require('./runtime-repair-provenance.cjs').provenance({ github, context, pr: managed,
      files: await github.paginate(github.rest.pulls.listFiles, { ...context.repo, pull_number: managed.number, per_page: 100 }), comments, commits, bot })) return existing.number;
    if (!publication) {
      throw new Error('Runtime head has no trusted publication receipt; preserve it for review');
    }
    if (existing?.labels?.some(l => l.name === 'no-runtime-update')) return existing.number;
    if (!plan.changed) {
      // The official discovery result is already in main; retire only a managed,
      // unedited current-line proposal superseded by that canonical state.
      const before = String(publication.version).split('.').map(Number), after = plan.version.split('.').map(Number);
      const superseded = /^\d+\.\d+\.\d+$/.test(publication.version || '') &&
        (after[0] - before[0] || after[1] - before[1] || after[2] - before[2]) >= 0;
      if (superseded && existing && plan.channel === 'current' && retireSuperseded && !existing.labels?.some(l => ['no-automerge', 'no-runtime-update'].includes(l.name))) {
        const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: existing.number });
        if (current.head.sha !== old || current.base.ref !== 'main' || current.labels.some(l => ['no-automerge', 'no-runtime-update'].includes(l.name))) throw new Error('Runtime PR changed before superseded cleanup');
        await github.rest.issues.createComment({ ...context.repo, issue_number: existing.number,
          body: `${MARKER}\n${JSON.stringify({ kind: 'superseded', sha: old, runtime: plan.runtime, channel: plan.channel, base: base.object.sha })}\n\nこの更新は管理表の現在の状態に含まれているため終了します。次の更新は同じ管理ブランチから作成できます。` });
        await github.rest.pulls.update({ ...context.repo, pull_number: existing.number, state: 'closed' });
        core.info(`Closed superseded runtime PR #${existing.number}`);
      }
      return;
    }
    // Avoid adding identical commits on every scheduled run.
    const { data: diff } = await github.rest.repos.compareCommits({ ...context.repo, base: old, head: base.object.sha });
    const same = await Promise.all(Object.entries(plan.files).map(async ([path, content]) => {
      try {
        const { data } = await github.rest.repos.getContent({ ...context.repo, path, ref: old });
        return NodeBuffer.from(data.content, 'base64').toString('utf8') === content;
      } catch (error) { if (error.status === 404) return false; throw error; }
    }));
    if (existing && diff.ahead_by === 0 && same.every(Boolean)) return existing.number;
  }
  const tree = [];
  for (const [path, content] of Object.entries(plan.files)) {
    const { data } = await github.rest.git.createBlob({ ...context.repo, content, encoding: 'utf-8' });
    tree.push({ path, mode: '100644', type: 'blob', sha: data.sha });
  }
  const { data: baseCommit } = await github.rest.git.getCommit({ ...context.repo, commit_sha: base.object.sha });
  const { data: nextTree } = await github.rest.git.createTree({ ...context.repo, base_tree: baseCommit.tree.sha, tree });
  const name = { node: 'Node.js', python: 'Python', npm: 'npm', pip: 'pip', uv: 'uv' }[plan.runtime];
  const title = `chore(runtime): update ${name} to ${plan.version}`;
  const { data: commit } = await github.rest.git.createCommit({ ...context.repo, message: title, tree: nextTree.sha,
    parents: old && old !== base.object.sha ? [base.object.sha, old] : [base.object.sha] });
  if (old) {
    const current = (await github.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` })).data.object.sha;
    if (current !== old) throw new Error('Runtime branch changed while preparing the update');
    await github.rest.git.updateRef({ ...context.repo, ref: `heads/${branch}`, sha: commit.sha, force: false });
  } else {
    await github.rest.git.createRef({ ...context.repo, ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  const body = [
    'Local/CI runtime pins, verified tool downloads and generated installation blocks are updated from the runtime manifest. Docker image tags and digests are managed separately by Dependabot.',
    plan.channel === 'next' ? 'This proposes a new interpreter release line. Missing wheels, provider support, or compatibility failures must be resolved before merging. Current-line security updates have a separate PR.' : 'This tracks the current interpreter release line, including security fixes.',
    plan.channel === 'current' ? 'Normal CI and strict branch protection must pass before automatic merging. The canonical manifest and generated pins stay together.' : 'New release lines require human review; this workflow does not enable automatic merging for them.',
  ].join('\n\n');
  const result = existing
    ? await github.rest.pulls.update({ ...context.repo, pull_number: existing.number, base: 'main', title, body })
    : await github.rest.pulls.create({ ...context.repo, head: branch, base: 'main', title, body });
  await github.rest.issues.createComment({ ...context.repo, issue_number: result.data.number,
    body: `${MARKER}\n${JSON.stringify({ kind: 'publication', sha: commit.sha, base: base.object.sha, runtime: plan.runtime,
      channel: plan.channel, version: plan.version, previous_version: plan.previous_version })}\n\n管理表と生成ファイルをまとめて更新しました。既存系列のみ、必須CI成功後の自動マージ対象です。` });
  core.info(`Prepared interpreter update PR #${result.data.number}`);
  return result.data.number;
}

module.exports = { validate, publish, FILES, sameLine, receipts, ownedCommits, eligible, scope };
