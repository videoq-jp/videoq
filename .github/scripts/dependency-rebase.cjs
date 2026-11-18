// Trusted main code only. Never check out or execute the dependency PR.
const policy = require('./dependency-automation.cjs');
const { verifiedUpdateTypes } = require('./terraform-dependency-apply.cjs');
const REPO = 'videoq-jp/videoq';
const MARKER = '<!-- videoq-dependency-rebase-v1 -->';
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const ecosystems = ['npm_and_yarn', 'uv', 'pip', 'docker', 'docker_compose', 'terraform', 'github_actions'];

function records(comments) {
  return comments.filter(c => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER + '\n'))
    .flatMap(c => { try { return [JSON.parse(c.body.split('\n')[1])]; } catch { return []; } });
}
function canonical(files) {
  if (!files?.length || files.length > 82) return null;
  const result = [];
  for (const file of files) {
    if (file.status !== 'modified' || !file.patch || !Number.isInteger(file.changes)) return null;
    const lines = file.patch.split('\n').filter(l => ['+', '-'].includes(l[0]));
    // Missing/truncated patches and binary changes cannot prove preservation.
    if (!lines.length || lines.length !== file.changes) return null;
    result.push({ path: file.filename, lines });
  }
  return JSON.stringify(result.sort((a, b) => a.path.localeCompare(b.path)));
}
function signedMetadata(commits, files) {
  if (!policy.verifiedDependencyCommits(commits, commits.at(-1)?.sha)) return null;
  const types = commits.flatMap(c => verifiedUpdateTypes(c, { allowMissingTypes: true }) || ['invalid']);
  if (!types.length || types.some(t => !['version-update:semver-patch', 'version-update:semver-minor', 'version-update:semver-major'].includes(t))) return null;
  const updateType = types.includes('version-update:semver-major') ? 'version-update:semver-major' : types.includes('version-update:semver-minor') ? 'version-update:semver-minor' : 'version-update:semver-patch';
  for (const ecosystem of ecosystems) {
    const metadata = { ecosystem, updateType, maintainerChanges: 'false' };
    if (policy.autoMergeMetadata(metadata, files)) return metadata;
  }
  return null;
}
async function snapshotMetadata(args, depth = 0) {
  const { github, context, files, comments, commits } = args;
  const normal = signedMetadata(commits, files);
  if (normal) return normal;
  if (depth > 24) return null;
  const resolved = await require('./dependency-resolution.cjs').provenance(args, depth);
  if (resolved) return resolved.metadata;
  const repair = require('./claude-dependency-repair.cjs');
  const expanded = await expandHistory(args, depth + 1);
  const history = repair.chain(expanded.commits, comments, expanded.aliases);
  if (!history || !history.repairs.length) return null;
  const index = expanded.commits.findIndex(c => c.sha === history.origin.sha);
  const prefix = expanded.commits.slice(0, index + 1);
  const base = prefix[0]?.parents?.[0]?.sha;
  if (!sha(base)) return null;
  const { data: original } = await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${base}...${history.origin.sha}` });
  const metadata = signedMetadata(prefix, original.files);
  if (!metadata) return null;
  for (const receipt of history.repairs) {
    const { data: diff } = await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${receipt.parent}...${receipt.sha}` });
    if (!await repair.validRepairDiff({ github, context, parent: receipt.parent, head: receipt.sha, diff })) return null;
  }
  const dependencyPaths = new Set(original.files.map(f => f.filename));
  if (!files.every(f => dependencyPaths.has(f.filename) || (['modified', 'added'].includes(f.status) && repair.compatibilityFile(f.filename)))) return null;
  return metadata;
}
async function provenance(args, depth = 0) {
  const { github, context, pr, files, comments, commits } = args;
  if (depth > 24) return null;
  const resolved = await require('./dependency-resolution.cjs').provenance(args, depth);
  if (resolved) return resolved;
  const normal = signedMetadata(commits, files);
  if (normal) {
    if (!canonical(files) || commits[0].parents?.length !== 1) return null;
    return { metadata: normal, originalHead: pr.head.sha, originalBase: commits[0].parents[0].sha };
  }
  const receipt = records(comments).find(r => r.kind === 'completed' && r.sha === pr.head.sha &&
    [r.originalHead, r.originalBase, r.base].every(sha));
  if (!receipt) {
    const metadata = await snapshotMetadata(args, depth);
    if (!metadata || !canonical(files) || commits[0]?.parents?.length !== 1) return null;
    return { metadata, originalHead: pr.head.sha, originalBase: commits[0].parents[0].sha };
  }
  const snapshotHead = receipt.snapshotHead || receipt.originalHead;
  const snapshotBase = receipt.snapshotBase || receipt.originalBase;
  if (![snapshotHead, snapshotBase].every(sha)) return null;
  const { data: original } = await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${snapshotBase}...${snapshotHead}` });
  if (original.total_commits !== original.commits?.length || original.total_commits > 50) return null;
  const metadata = await snapshotMetadata({ ...args, commits: original.commits, files: original.files,
    pr: { ...pr, head: { ...pr.head, sha: snapshotHead } } }, depth + 1);
  if (!metadata || original.commits.at(-1)?.sha !== snapshotHead) return null;
  const { data: rebased } = await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${receipt.base}...${pr.head.sha}` });
  const before = canonical(original.files);
  if (!before || canonical(rebased.files) !== before || canonical(files) !== before) return null;
  return { metadata, originalHead: receipt.originalHead, originalBase: receipt.originalBase, originalCommits: original.commits };
}
async function expandHistory(args, depth = 0) {
  const unchanged = { commits: args.commits, aliases: {} };
  if (depth > 4) return unchanged;
  const receipt = records(args.comments).reverse().find(r => r.kind === 'completed' && args.commits.some(c => c.sha === r.sha));
  if (!receipt || !sha(receipt.base)) return unchanged;
  const index = args.commits.findIndex(c => c.sha === receipt.sha);
  const { data: snapshot } = await args.github.rest.repos.compareCommitsWithBasehead({ ...args.context.repo, basehead: `${receipt.base}...${receipt.sha}` });
  const proof = await provenance({ ...args, pr: { ...args.pr, head: { ...args.pr.head, sha: receipt.sha } },
    files: snapshot.files, commits: args.commits.slice(0, index + 1) }, depth + 1);
  if (!proof?.originalCommits) return unchanged;
  const previous = await expandHistory({ ...args, commits: proof.originalCommits }, depth + 1);
  return { commits: [...previous.commits, ...args.commits.slice(index + 1)],
    aliases: { ...previous.aliases, [receipt.sha]: previous.commits.at(-1).sha } };
}
function requireMain(context) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPO || context.ref !== 'refs/heads/main') throw new Error('Main repository workflow required');
}
async function candidate({ github, context, number, now = new Date() }) {
  requireMain(context);
  const { pr, files, comments } = await policy.getPull({ github, context, number });
  const sourceFile = require('./claude-dependency-repair.cjs').sourceFile;
  if (files.length > 82 ||
    !policy.eligiblePull(pr, files.filter(f => !sourceFile(f.filename)), 'no-automerge', comments) ||
    pr.labels.some(l => l.name === 'no-rebase')) return null;
  const commits = await github.paginate(github.rest.pulls.listCommits, { ...context.repo, pull_number: number, per_page: 100 });
  if (commits.at(-1)?.sha !== pr.head.sha) return null;
  const proof = await provenance({ github, context, pr, files, comments, commits });
  if (!proof) return null;
  const { data: main } = await github.rest.repos.getBranch({ ...context.repo, branch: 'main' });
  const { data: diff } = await github.rest.repos.compareCommits({ ...context.repo, base: main.commit.sha, head: pr.head.sha });
  if (diff.behind_by < 1) return null;
  const attempts = records(comments).filter(r => r.kind === 'requested' && r.sha === pr.head.sha && r.base === main.commit.sha);
  if (attempts.length >= 3 || attempts.some(r => !Number.isFinite(Date.parse(r.at)) || now - Date.parse(r.at) < 30 * 60_000)) return null;
  return { pr, files, comments, ...proof, base: main.commit.sha,
    snapshotBase: diff.merge_base_commit?.sha || proof.originalBase };
}
async function record(github, context, number, data, message) {
  await github.rest.issues.createComment({ ...context.repo, issue_number: number, body: `${MARKER}\n${JSON.stringify(data)}\n\n${message}` });
}
async function update(args) {
  const { github, writerGithub, context, number, expectedSha, now = new Date(), wait = ms => new Promise(r => setTimeout(r, ms)) } = args;
  const c = await candidate(args);
  if (!c || c.pr.head.sha !== expectedSha) return null;
  const { data: protection } = await writerGithub.rest.repos.getBranchProtection({ ...context.repo, branch: 'main' });
  const { data: rules } = await writerGithub.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', { ...context.repo, branch: 'main' });
  require('./native-dependency-queue.cjs').requireProtection(protection, rules);
  await record(github, context, number, { kind: 'requested', sha: expectedSha, base: c.base, at: now.toISOString() },
    '最新mainへの追従を自動実行します。依存更新の内容を維持し、追従後のCIを待ちます。');
  // Revalidate immediately before mutation; expectedHeadOid also rejects concurrent changes.
  const fresh = await policy.getPull({ github, context, number });
  if (fresh.pr.head.sha !== expectedSha || fresh.pr.labels.some(l => ['no-automerge', 'no-rebase'].includes(l.name))) return null;
  await writerGithub.graphql(`mutation($id:ID!,$sha:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$sha,updateMethod:MERGE}){clientMutationId}}`, { id: c.pr.node_id, sha: expectedSha });
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(5000);
    const current = await policy.getPull({ github, context, number });
    if (current.pr.head.sha === expectedSha) continue;
    const { data: main } = await github.rest.repos.getBranch({ ...context.repo, branch: 'main' });
    const { data: diff } = await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${main.commit.sha}...${current.pr.head.sha}` });
    if (!canonical(c.files) || canonical(diff.files) !== canonical(c.files) || canonical(current.files) !== canonical(c.files)) throw new Error('Rebase changed dependency content; merge remains subject to verification');
    const base = diff.merge_base_commit?.sha;
    if (!sha(base)) throw new Error('Cannot verify the rebased main ancestor');
    await record(github, context, number, { kind: 'completed', sha: current.pr.head.sha, base,
      originalHead: c.originalHead, originalBase: c.originalBase,
      snapshotHead: expectedSha, snapshotBase: c.snapshotBase },
      '最新mainへの追従が完了しました。署名済みの元更新と差分が同一であることを確認しました。必須CI成功後に自動マージします。');
    return { number, sha: current.pr.head.sha };
  }
  throw new Error('GitHub branch update did not finish in time; a later run can retry');
}
module.exports = { canonical, records, signedMetadata, provenance, expandHistory, candidate, update };
