// Load only from the trusted workflow revision, never the model's checkout.
const policy = require('./dependency-automation.cjs');
const { execFileSync } = require('node:child_process');
const { readFileSync, lstatSync } = require('node:fs');
const { resolve } = require('node:path');
const MARKER = '<!-- videoq-claude-dependency-v1 -->';
const REPO = 'videoq-jp/videoq';
const sha = value => /^[a-f0-9]{40}$/.test(value || '');

function records(comments, kind) {
  return comments.filter(c => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER + '\n'))
    .flatMap(c => { try { return [JSON.parse(c.body.split('\n')[1])]; } catch { return []; } })
    .filter(r => r.kind === kind);
}
async function record(github, context, number, data, message = '') {
  await github.rest.issues.createComment({ ...context.repo, issue_number: number,
    body: `${MARKER}\n${JSON.stringify(data)}\n\n${message}` });
}
async function seed({ github, context, pr, metadata }) {
  const { comments } = await policy.getPull({ github, context, number: pr.number });
  if (records(comments, 'seed').some(r => r.sha === pr.head.sha)) return;
  await record(github, context, pr.number, { kind: 'seed', sha: pr.head.sha, metadata },
    'Claude自動修正用の依存更新情報を検証しました。修正は機能が有効な場合のCI失敗時のみ実行します。');
}
// Application compatibility includes build configuration, tests and generated types.
// Automation, infrastructure and secret/authentication policy stay trusted-main only.
function sourceFile(path) {
  return /^(?:apps\/(?:api|web|docs|demo-video|worker|inference)\/|packages\/trpc\/)[a-zA-Z0-9_./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|json|jsonc|toml|ya?ml|css|mdx)$/.test(path) &&
    !/(?:^|\/)(?:\.\.?|node_modules|vendor|dist|build)(?:\/|$)|(?:^|[./_-])(?:secrets?|credentials|env)(?:[./_-]|$)/.test(path) &&
    !/(?:^|\/)(?:package(?:-lock)?\.json|pyproject\.toml|uv\.lock)$/.test(path);
}
// Container compatibility edits can accompany an image update, but the image
// references and verified tool-installation blocks remain owned by their bots.
function dockerFile(path) {
  return /^(?:apps\/(?:api|web|worker|inference\/whisper))\/Dockerfile(?:\.(?:local|dev|onprem))?$/.test(path);
}
function compatibilityFile(path) { return sourceFile(path) || dockerFile(path); }
function dockerPatch(file) {
  if (!dockerFile(file.filename)) return true;
  if (file.status !== 'modified' || !file.patch) return false;
  // Reject visible protected changes early; full-file comparison below also
  // checks blocks whose opening marker is outside the diff context.
  let managed = false;
  for (const line of file.patch.split('\n')) {
    if (/^[ +\-]# BEGIN managed /.test(line)) managed = true;
    if (/^[+\-]/.test(line) && (managed || /^\s*(?:FROM\s|ARG\s+(?:PYTHON|NPM|PIP|UV)_(?:VERSION|URL|SHA256|INTEGRITY)=)/i.test(line.slice(1)))) return false;
    if (/^[ +\-]# END managed /.test(line)) managed = false;
  }
  return true;
}
function sameDockerPins(before, after) {
  const protectedLines = text => text.match(/^(?:FROM .*|ARG (?:PYTHON|NPM|PIP|UV)_(?:VERSION|URL|SHA256|INTEGRITY)=.*)$/gm) || [];
  const blocks = text => text.match(/^# BEGIN managed [\s\S]*?^# END managed .*$/gm) || [];
  return JSON.stringify(protectedLines(before)) === JSON.stringify(protectedLines(after)) &&
    JSON.stringify(blocks(before)) === JSON.stringify(blocks(after));
}
async function validRepairDiff({ github, context, parent, head, diff }) {
  if (diff.total_commits !== 1 || !validRepairFiles(diff.files || [])) return false;
  for (const file of diff.files.filter(file => dockerFile(file.filename))) {
    const contents = [];
    for (const ref of [parent, head]) {
      const { data } = await github.rest.repos.getContent({ ...context.repo, path: file.filename, ref });
      if (data.type !== 'file' || data.encoding !== 'base64') return false;
      contents.push(Buffer.from(data.content, 'base64').toString('utf8'));
    }
    if (!sameDockerPins(...contents)) return false;
  }
  return true;
}
const POLICY_VERSION = 2;
const MAX_ATTEMPTS = 8;
function attempts(comments, mode = 'ci') {
  return records(comments, 'attempt').filter(r => r.policy === POLICY_VERSION && (r.mode || 'ci') === mode);
}
// A completed final attempt must produce one actionable stop notice, even when
// the controller rejects another dispatch before scope() is called.
async function stopIfExhausted({ github, context, pr, comments, mode = 'ci' }) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPO || context.ref !== 'refs/heads/main' ||
      !['ci', 'conflict'].includes(mode)) throw new Error('Stop notices require canonical main and a repair mode.');
  if (attempts(comments, mode).length < MAX_ATTEMPTS) return false;
  const worker = records(comments, 'worker-start').at(-1);
  if (worker) {
    const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: worker.runId });
    if (run.status !== 'completed') return false;
  }
  if (!records(comments, 'stopped').some(r => r.policy === POLICY_VERSION && r.mode === mode)) {
    const checks = `https://github.com/${REPO}/pull/${pr.number}/checks`;
    const log = /^\d+$/.test(String(worker?.runId)) ? `https://github.com/${REPO}/actions/runs/${worker.runId}` : checks;
    await record(github, context, pr.number,
      { kind: 'stopped', policy: POLICY_VERSION, mode, sha: pr.head.sha },
      `Claudeの${mode === 'ci' ? 'CI修正' : '競合解消'}が最大${MAX_ATTEMPTS}回に達したため、自動再試行を停止しました。人による確認が必要です。実行ログ: ${log}\nCI結果: ${checks}`);
  }
  return true;
}
async function mayAttempt({ github, context, comments, head, mode = 'ci', base }) {
  const history = attempts(comments, mode);
  if (history.length >= MAX_ATTEMPTS) return false;
  const prior = history.filter(r => r.sha === head && (mode !== 'conflict' || r.base === base));
  if (prior.length >= MAX_ATTEMPTS) return false;
  const worker = records(comments, 'worker-start').at(-1);
  if (worker) {
    const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: worker.runId });
    if (run.status !== 'completed') return false;
  }
  if (!prior.length) return true;
  // The attempt receipt reserves dispatch before a worker has claimed it. A
  // completed worker may retry within the existing budget; unrelated events cannot.
  return !!worker && worker.authorizationRun === prior.at(-1).runId;
}
function validRepairFiles(files) {
  return files.length > 0 && files.length <= 32 &&
    files.every(f => ['modified', 'added'].includes(f.status) && compatibilityFile(f.filename) && dockerPatch(f) && f.patch &&
      Number.isInteger(f.changes) && f.changes > 0) &&
    files.reduce((sum, f) => sum + f.changes, 0) <= 2000;
}
function chain(commits, comments, aliases = {}) {
  for (const origin of records(comments, 'seed').reverse()) {
    const index = commits.findIndex(c => c.sha === origin.sha);
    if (index < 0 || !policy.verifiedDependencyCommits(commits.slice(0, index + 1), origin.sha)) continue;
    const repairs = commits.slice(index + 1);
    if (repairs.length > MAX_ATTEMPTS + 2) continue;
    let parent = origin.sha;
    const accepted = [];
    for (const commit of repairs) {
      const receipt = records(comments, 'published').find(r => r.sha === commit.sha && (aliases[r.parent] || r.parent) === parent &&
        r.origin === origin.sha && /^\d+$/.test(String(r.runId)));
      if (!receipt || commit.parents?.length !== 1 || (aliases[commit.parents[0].sha] || commit.parents[0].sha) !== parent) break;
      accepted.push(receipt); parent = commit.sha;
    }
    if (accepted.length === repairs.length) return { origin, repairs: accepted };
  }
  return null;
}
async function candidate({ github, context, runId, mode = 'ci', number, baseSha }) {
  if (mode === 'conflict') return require('./dependency-resolution.cjs').candidate({ github, context, number, baseSha });
  if (`${context.repo.owner}/${context.repo.repo}` !== REPO || context.ref !== 'refs/heads/main' || !/^\d+$/.test(String(runId))) throw new Error('Invalid repair invocation');
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId });
  const { data: workflow } = await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: 'ci.yml' });
  if (run.workflow_id !== workflow.id || run.event !== 'pull_request' || run.status !== 'completed' ||
    !['success', 'failure'].includes(run.conclusion) || run.repository?.full_name !== REPO || run.head_repository?.full_name !== REPO) return null;
  const { data: pulls } = await github.rest.pulls.list({ ...context.repo, state: 'open', head: `${context.repo.owner}:${run.head_branch}`, base: 'main' });
  if (pulls.length !== 1) return null;
  const { pr, files, comments } = await policy.getPull({ github, context, number: pulls[0].number });
  if (pr.head.sha !== run.head_sha || !sha(pr.head.sha) || pr.state !== 'open' || pr.draft ||
    !['dependabot[bot]', process.env.DEPENDENCY_BOT_LOGIN || 'videoq-dependency-bot[bot]'].includes(pr.user?.login) || pr.head.repo?.full_name !== REPO || pr.base.repo?.full_name !== REPO ||
    pr.base.ref !== 'main' ||
    pr.labels.some(l => ['no-automerge', 'no-claude', 'no-codex'].includes(l.name))) return null;
  const { data: runs } = await github.rest.actions.listWorkflowRuns({ ...context.repo, workflow_id: workflow.id, head_sha: run.head_sha, event: 'pull_request', per_page: 100 });
  const latest = runs.workflow_runs.sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.id !== run.id || latest.run_attempt !== run.run_attempt) return null;
  const commits = await github.paginate(github.rest.pulls.listCommits, { ...context.repo, pull_number: pr.number, per_page: 100 });
  if (commits.at(-1)?.sha !== pr.head.sha) return null;
  if (pr.user.login !== 'dependabot[bot]') {
    const proof = await require('./runtime-repair-provenance.cjs').provenance({ github, context, pr, files, comments, commits });
    if (!proof) return null;
    return { pr, files, comments, run, origin: { sha: proof.originalHead, metadata: { ecosystem: 'runtime' } },
      repairs: [], proof };
  }
  if (!pr.head.ref.startsWith('dependabot/')) return null;
  const expanded = await require('./dependency-rebase.cjs').expandHistory({ github, context, pr, files, comments, commits });
  const resolved = await require('./dependency-rebase.cjs').provenance({ github, context, pr, files, comments, commits });
  const history = chain(expanded.commits, comments, expanded.aliases) ||
    (resolved ? { origin: { sha: resolved.originalHead, metadata: resolved.metadata }, repairs: [] } : null);
  if (!history || !history.origin.metadata?.ecosystem) return null;
  // Verify the seed against the original dependency-only diff, even after source repairs.
  const { data: original } = await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${pr.base.sha}...${history.origin.sha}` });
  if (!policy.autoMergeMetadata(history.origin.metadata, original.files || [])) return null;
  for (const repair of history.repairs) {
    const { data: diff } = await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${repair.parent}...${repair.sha}` });
    if (!await validRepairDiff({ github, context, parent: repair.parent, head: repair.sha, diff })) return null;
  }
  // Reject files outside the union of the verified original and repair diffs.
  if (files.length > 82) return null;
  return { pr, files, comments, run, ...history, proof: resolved };
}
async function scope(args) {
  if (args.mode === 'conflict') return require('./dependency-resolution.cjs').scope(args);
  const c = await candidate(args);
  if (!c || c.run.conclusion !== 'failure') return null;
  const { github, context } = args;
  if (c.pr.auto_merge) {
    if (!args.writerGithub) throw new Error('A write-capable GitHub App client is required to cancel auto-merge');
    await args.writerGithub.graphql('mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }', { id: c.pr.node_id });
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...context.repo, run_id: c.run.id, filter: 'latest', per_page: 100 });
  if (['Supply Chain Security', 'Deployment Security Tests'].some(name => !jobs.some(j => j.name === name && j.conclusion === 'success'))) {
    if (!records(c.comments, 'security-stop').some(r => r.sha === c.pr.head.sha)) await record(github, context, c.pr.number,
      { kind: 'security-stop', sha: c.pr.head.sha }, `セキュリティ検査が成功していないためClaude自動修正を停止しました。人による確認が必要です。CI結果: https://github.com/${REPO}/actions/runs/${c.run.id}`);
    return null;
  }
  // Upload/service failures and the aggregate result cannot be fixed by editing
  // application source. Preserve the bounded attempts for an actual test/build
  // failure; mixed failures can still receive a source compatibility repair.
  const reporting = new Set(['CI Success', 'Container Validation', 'Terraform Plan', 'Frontend Coverage']);
  // Consolidating CI must not turn infrastructure checks or their aggregate
  // failures into application-repair attempts. Mixed application failures remain eligible.
  const infrastructure = name => name === 'operations-fixture' || /^(container-checks|terraform-checks) \/ /.test(name);
  if (!jobs.some(job => job.conclusion === 'failure' && !reporting.has(job.name) && !infrastructure(job.name))) {
    if (!records(c.comments, 'unsupported-stop').some(r => r.sha === c.pr.head.sha)) await record(github, context, c.pr.number,
      { kind: 'unsupported-stop', sha: c.pr.head.sha },
      `CIの失敗がアプリ修正の対象外（インフラ検証・成果物処理など）のためClaudeを起動していません。人による確認が必要です。CI結果: https://github.com/${REPO}/actions/runs/${c.run.id}`);
    return null;
  }
  if (await stopIfExhausted({ github, context, pr: c.pr, comments: c.comments })) return null;
  if (!await mayAttempt({ github, context, comments: c.comments, head: c.pr.head.sha })) return null;
  const attempt = { kind: 'attempt', policy: POLICY_VERSION, mode: 'ci', sha: c.pr.head.sha, origin: c.origin.sha, runId: String(context.runId), failedRun: c.run.id };
  await record(github, context, c.pr.number, attempt, 'CI失敗を受け、Claudeによる互換性修正を開始します（互換性修正は最大8回）。');
  return { number: c.pr.number, sha: c.pr.head.sha, branch: c.pr.head.ref, origin: c.origin.sha };
}
function git(cwd, ...args) { return execFileSync('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }); }
async function authorizedAttempt({ github, context, c, authorizationRun }) {
  if (!/^\d+$/.test(String(authorizationRun)) || !records(c.comments, 'attempt')
    .some(r => r.sha === c.pr.head.sha && r.runId === String(authorizationRun) &&
      (r.mode || 'ci') === (c.mode || 'ci') && (c.mode !== 'conflict' || r.base === c.baseSha))) return false;
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: authorizationRun });
  const { data: workflow } = await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: 'dependency-queue.yml' });
  return run.workflow_id === workflow.id && run.repository?.full_name === REPO && run.head_repository?.full_name === REPO &&
    run.head_branch === 'main' && ['push', 'workflow_run', 'workflow_dispatch'].includes(run.event);
}
async function claimWorker(args) {
  const c = await candidate(args);
  if (!c || (c.mode !== 'conflict' && c.run.conclusion !== 'failure') || c.pr.head.sha !== args.expectedSha ||
    String(c.pr.number) !== String(args.number) || !await authorizedAttempt({ ...args, c }) ||
    records(c.comments, 'worker-start').some(r => r.authorizationRun === String(args.authorizationRun))) throw new Error('Repair already claimed or unauthorized');
  await record(args.github, args.context, c.pr.number, { kind: 'worker-start', sha: c.pr.head.sha,
    authorizationRun: String(args.authorizationRun), runId: String(args.context.runId) }, '読み取り専用のClaude修正ジョブを開始します。');
}
function applyPatch(cwd, patchPath) {
  if (lstatSync(patchPath).size > 200000) throw new Error('Patch too large');
  git(cwd, 'apply', '--check', '--', patchPath);
  git(cwd, 'apply', '--index', '--', patchPath);
  const entries = git(cwd, 'diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames').split('\0');
  const files = [];
  for (let i = 0; i < entries.length - 1; i += 2) {
    const match = entries[i].match(/^:(?:100644 100644 [a-f0-9]{40} [a-f0-9]{40} M|000000 100644 0{40} [a-f0-9]{40} A)$/);
    const path = entries[i + 1];
    if (!match || !compatibilityFile(path) || !lstatSync(resolve(cwd, path)).isFile()) throw new Error('Forbidden repair path or mode');
    if (dockerFile(path)) {
      const before = git(cwd, 'show', `HEAD:${path}`);
      const after = readFileSync(resolve(cwd, path), 'utf8');
      if (!sameDockerPins(before, after)) throw new Error('Container repair changed protected pins or installation blocks');
    }
    files.push(path);
  }
  const stats = git(cwd, 'diff', '--cached', '--numstat', '--no-renames').trim().split('\n');
  if (!files.length || files.length > 32 || stats.some(s => !/^\d+\t\d+\t/.test(s)) ||
    stats.reduce((n, s) => n + Number(s.split('\t')[0]) + Number(s.split('\t')[1]), 0) > 2000) throw new Error('Repair exceeds limits');
  return files;
}
async function publish(args) {
  if (args.mode === 'conflict') return require('./dependency-resolution.cjs').publish(args);
  const { writerGithub: github, context, expectedSha, cwd, patchPath } = args;
  const c = await candidate(args);
  if (!c || c.run.conclusion !== 'failure' || c.pr.head.sha !== expectedSha ||
    !await authorizedAttempt({ ...args, c }) || !records(c.comments, 'worker-start').some(r =>
      r.sha === expectedSha && r.authorizationRun === String(args.authorizationRun) && r.runId === String(context.runId))) throw new Error('Stale or unapproved repair');
  const files = applyPatch(cwd, patchPath);
  const tree = [];
  for (const path of files) {
    const { data: blob } = await github.rest.git.createBlob({ ...context.repo, content: readFileSync(resolve(cwd, path)).toString('base64'), encoding: 'base64' });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const { data: parent } = await github.rest.git.getCommit({ ...context.repo, commit_sha: expectedSha });
  const { data: newTree } = await github.rest.git.createTree({ ...context.repo, base_tree: parent.tree.sha, tree });
  const { data: commit } = await github.rest.git.createCommit({ ...context.repo, message: `fix: compatibility after dependency update (#${c.pr.number})`, tree: newTree.sha, parents: [expectedSha] });
  // Write the receipt before push: the synchronize workflow can immediately verify the new SHA.
  await record(args.github, context, c.pr.number, { kind: 'published', policy: POLICY_VERSION, mode: 'ci', sha: commit.sha, parent: expectedSha, origin: c.origin.sha, originalBase: c.proof?.originalBase || c.pr.base.sha, runId: String(context.runId) },
    `Claudeの修正を反映します: ${commit.sha}。通常のCIが成功するまでマージしません。`);
  const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: c.pr.number });
  if (current.head.sha !== expectedSha || current.labels.some(l => ['no-automerge', 'no-claude', 'no-codex'].includes(l.name))) throw new Error('PR changed during repair');
  await github.rest.git.updateRef({ ...context.repo, ref: `heads/${c.pr.head.ref}`, sha: commit.sha, force: false });
}
module.exports = { POLICY_VERSION, MAX_ATTEMPTS, attempts, stopIfExhausted, mayAttempt, record, records, seed, sourceFile, compatibilityFile, validRepairFiles, validRepairDiff, chain, candidate, scope, authorizedAttempt, claimWorker, applyPatch, publish };
