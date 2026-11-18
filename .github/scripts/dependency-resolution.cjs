// Conflict resolution shares the isolated Claude worker. Only trusted-main code
// may authorize or publish; a model-produced merge is never trusted by author name.
const { execFileSync } = require('node:child_process');
const { readFileSync, lstatSync } = require('node:fs');
const { resolve } = require('node:path');
const policy = require('./dependency-automation.cjs');
const REPO = 'videoq-jp/videoq';
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const repair = () => require('./claude-dependency-repair.cjs');
const sync = () => require('./dependency-rebase.cjs');
function git(cwd, ...args) {
  return execFileSync('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}
function allowedFiles(files, metadata) {
  if (!files.length || files.length > 82) return false;
  const application = files.filter(file => repair().sourceFile(file.filename));
  const dependencies = files.filter(file => !repair().sourceFile(file.filename));
  return (!application.length || repair().validRepairFiles(application)) &&
    (!dependencies.length || (metadata?.ecosystem === 'runtime'
      ? dependencies.every(file => file.status === 'modified' && metadata.paths?.includes(file.filename) && require('./runtime-pull-request.cjs').FILES.has(file.filename))
      : policy.autoMergeMetadata(metadata, dependencies)));
}

// Verify receipts recursively, exact Git parents and trusted main ancestry.
// A receipt alone cannot launder an arbitrary branch or a human follow-up commit.
async function provenance(args, depth = 0) {
  const { github, context, pr, files, comments } = args;
  if (depth > 24) return null;
  const receipt = repair().records(comments, 'published').find(r => r.policy === 2 && r.sha === pr.head.sha &&
    [r.parent, r.origin, r.originalBase].every(sha) && /^\d+$/.test(String(r.runId)));
  if (!receipt || !['ci', 'conflict'].includes(receipt.mode)) return null;
  const { data: head } = await github.rest.git.getCommit({ ...context.repo, commit_sha: receipt.sha });
  const parents = head.parents.map(parent => parent.sha);
  if (JSON.stringify(parents) !== JSON.stringify(receipt.mode === 'conflict' ? [receipt.parent, receipt.base] : [receipt.parent])) return null;
  const { data: previous } = await github.rest.repos.compareCommitsWithBasehead({
    // The parent may have been rebased onto a newer trusted main. Comparing
    // from its ancient origin base would incorrectly include main's commits.
    ...context.repo, basehead: `${pr.base.sha}...${receipt.parent}`,
  });
  if (previous.total_commits !== previous.commits?.length) return null;
  const proof = await sync().provenance({ ...args, pr: { ...pr, head: { ...pr.head, sha: receipt.parent } },
    files: previous.files, commits: previous.commits }, depth + 1);
  if (!proof || proof.originalHead !== receipt.origin) return null;
  if (receipt.mode === 'ci') {
    const { data: delta } = await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo, basehead: `${receipt.parent}...${receipt.sha}`,
    });
    if (!await repair().validRepairDiff({ github, context, parent: receipt.parent, head: receipt.sha, diff: delta })) return null;
  } else {
    if (!sha(receipt.base)) return null;
    const { data: main } = await github.rest.repos.getBranch({ ...context.repo, branch: 'main' });
    const { data: ancestry } = await github.rest.repos.compareCommits({ ...context.repo, base: receipt.base, head: main.commit.sha });
    if (ancestry.merge_base_commit?.sha !== receipt.base) return null;
    const { data: delta } = await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo, basehead: `${receipt.base}...${receipt.sha}`,
    });
    if (!allowedFiles(delta.files || [], proof.metadata)) return null;
    if (!await preservedTargets({ github, context, proof, ref: receipt.sha, base: receipt.base })) return null;
  }
  if (!allowedFiles(files || [], proof.metadata)) return null;
  return { ...proof, resolved: true };
}

async function candidate({ github, context, number, baseSha }) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPO || context.ref !== 'refs/heads/main' ||
      !/^[1-9][0-9]*$/.test(String(number)) || !sha(baseSha)) return null;
  const pull = await policy.getPull({ github, context, number });
  if (pull.pr.mergeable !== false || pull.pr.labels.some(label =>
    ['no-automerge', 'no-claude', 'no-codex', 'no-rebase'].includes(label.name))) return null;
  const application = repair().sourceFile;
  const runtimeBot = process.env.DEPENDENCY_BOT_LOGIN || 'videoq-dependency-bot[bot]';
  const isRuntime = pull.pr.user?.login === runtimeBot;
  if (!isRuntime && !policy.eligiblePull(pull.pr, pull.files.filter(file => !application(file.filename)), 'no-automerge', pull.comments)) return null;
  const commits = await github.paginate(github.rest.pulls.listCommits, { ...context.repo, pull_number: number, per_page: 100 });
  if (commits.at(-1)?.sha !== pull.pr.head.sha) return null;
  const proof = isRuntime
    ? await require('./runtime-repair-provenance.cjs').provenance({ github, context, ...pull, commits, bot: runtimeBot })
    : await sync().provenance({ github, context, ...pull, commits });
  if (!proof) return null;
  const { data: main } = await github.rest.repos.getBranch({ ...context.repo, branch: 'main' });
  if (main.commit.sha !== baseSha) return null;
  return { ...pull, proof, origin: { sha: proof.originalHead, metadata: proof.metadata }, mode: 'conflict', baseSha };
}
async function scope(args) {
  const c = await candidate(args);
  if (!c) return null;
  if (await repair().stopIfExhausted({ ...args, pr: c.pr, comments: c.comments, mode: 'conflict' })) return null;
  if (!await repair().mayAttempt({ ...args, comments: c.comments, head: c.pr.head.sha, mode: 'conflict', base: c.baseSha })) return null;
  await repair().record(args.github, args.context, c.pr.number, { kind: 'attempt', policy: 2, mode: 'conflict',
    sha: c.pr.head.sha, base: c.baseSha, origin: c.origin.sha, runId: String(args.context.runId) },
  '競合をClaudeで解消し、更新内容を維持して通常のCI・マージキューへ戻します。');
  return { number: c.pr.number, sha: c.pr.head.sha, branch: c.pr.head.ref, origin: c.origin.sha, mode: 'conflict', baseSha: c.baseSha };
}

async function content(github, context, ref, path) {
  // package-lock.json is >1 MB: contents metadata omits content at that size.
  // Fetch its exact blob rather than following an unvalidated download URL.
  let { data } = await github.rest.repos.getContent({ ...context.repo, ref, path });
  if (data.type === 'file' && data.encoding === 'none' && sha(data.sha)) {
    data = { ...(await github.rest.git.getBlob({ ...context.repo, file_sha: data.sha })).data, type: 'file' };
  }
  if (data.type !== 'file' || data.encoding !== 'base64') throw new Error('Cannot verify dependency target');
  return Buffer.from(data.content, 'base64').toString('utf8');
}
function targetLines(text) {
  return text.split('\n').filter(line => /^\s*(?:FROM\s|image:|version\s*=|uses:|-\s*uses:)/.test(line));
}
function lockVersions(path, text) {
  if (path.endsWith('package-lock.json')) return Object.fromEntries(Object.entries(JSON.parse(text).packages || {})
    .filter(([, value]) => value.version).map(([name, value]) => [name, value.version]));
  if (path.endsWith('uv.lock')) return Object.fromEntries(text.split(/^\[\[package\]\]\s*$/m).slice(1).flatMap(block => {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1], version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    return name && version ? [[`${name}==${version}`, version]] : [];
  }));
  if (path.endsWith('.terraform.lock.hcl')) return Object.fromEntries([...text.matchAll(/^provider "([^"]+)" \{([\s\S]*?)^\}/gm)]
    .flatMap(([, name, block]) => { const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1]; return version ? [[name, version]] : []; }));
  return null;
}
// Conflicts may regenerate lockfiles, but cannot resolve an update by reverting
// its requested direct dependency versions. No dependency installation runs here.
async function preservedTargets({ github, context, proof, ref, cwd, base }) {
  const { data: original } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo, basehead: `${proof.originalBase}...${proof.originalHead}`,
  });
  for (const file of original.files || []) {
    const before = await content(github, context, proof.originalBase, file.filename);
    const requested = await content(github, context, proof.originalHead, file.filename);
    const proposed = cwd ? readFileSync(resolve(cwd, file.filename), 'utf8') : await content(github, context, ref, file.filename);
    if (proof.metadata?.ecosystem === 'runtime') {
      if (!base) return false;
      const main = await content(github, context, base, file.filename);
      // A runtime conflict can combine existing pins and verified download
      // metadata, but cannot invent shell commands, URLs or hashes.
      const allowed = new Set([...main.split('\n'), ...requested.split('\n')]);
      if (proposed.split('\n').some(line => !allowed.has(line))) return false;
      const oldLines = new Set(before.split('\n'));
      const desired = requested.split('\n').filter(line => line.trim() && !oldLines.has(line));
      if (desired.some(line => !proposed.split('\n').includes(line))) return false;
    }
    const versions = lockVersions(file.filename, requested);
    if (versions) {
      const old = lockVersions(file.filename, before), result = lockVersions(file.filename, proposed);
      for (const [name, version] of Object.entries(versions)) {
        if (old[name] !== version && result[name] !== version) return false;
      }
    } else if (file.filename.endsWith('package.json')) {
      const old = JSON.parse(before), next = JSON.parse(requested), result = JSON.parse(proposed);
      const main = base ? JSON.parse(await content(github, context, base, file.filename)) : null;
      if (proof.metadata?.ecosystem === 'runtime' && old.packageManager !== next.packageManager && result.packageManager !== next.packageManager) return false;
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries(next[section] || {})) {
          if (old[section]?.[name] !== version && result[section]?.[name] !== version) return false;
        }
        for (const [name, version] of Object.entries(main?.[section] || {})) {
          if (old[section]?.[name] === next[section]?.[name] && result[section]?.[name] !== version) return false;
        }
      }
    } else {
      // Preserve every newly requested pin/constraint, including Python strings.
      const added = requested.split('\n').filter(line => !before.split('\n').includes(line) && line.trim());
      const constraints = proof.metadata?.ecosystem === 'runtime' || file.filename.endsWith('pyproject.toml') ? added : targetLines(added.join('\n'));
      if (constraints.some(line => !proposed.split('\n').includes(line))) return false;
    }
  }
  return true;
}

function applyPatch(cwd, patchPath, metadata) {
  if (!lstatSync(patchPath).isFile() || lstatSync(patchPath).size > 2_000_000) throw new Error('Invalid conflict patch');
  git(cwd, 'apply', '--check', '--', patchPath);
  git(cwd, 'apply', '--index', '--', patchPath);
  const raw = git(cwd, 'diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames').split('\0');
  const stats = git(cwd, 'diff', '--cached', '--numstat', '--no-renames').trim().split('\n');
  const files = [];
  for (let i = 0; i < raw.length - 1; i += 2) {
    const path = raw[i + 1];
    if (!/^:(?:100644 100644 [a-f0-9]{40} [a-f0-9]{40} M|000000 100644 0{40} [a-f0-9]{40} A)$/.test(raw[i]) ||
        /(?:^|\/)\.\.?(?:\/|$)/.test(path) || !lstatSync(resolve(cwd, path)).isFile()) throw new Error('Forbidden conflict path or mode');
    const text = readFileSync(resolve(cwd, path), 'utf8');
    if (/^(?:<{7}|={7}|>{7})(?: |$)/m.test(text)) throw new Error('Unresolved conflict markers');
    const stat = stats.find(row => row.split('\t')[2] === path)?.split('\t');
    if (!stat || !/^\d+$/.test(stat[0]) || !/^\d+$/.test(stat[1])) throw new Error('Binary conflict patch');
    files.push({ filename: path, status: raw[i].endsWith(' A') ? 'added' : 'modified',
      changes: Number(stat[0]) + Number(stat[1]), patch: git(cwd, 'diff', '--cached', '--', path) });
  }
  if (!allowedFiles(files, metadata)) throw new Error('Conflict resolution exceeded compatibility scope');
  return files.map(file => file.filename);
}

async function publish(args) {
  const { github, writerGithub, context, cwd, patchPath, expectedSha } = args;
  const c = await candidate(args);
  if (!c || c.pr.head.sha !== expectedSha || !await repair().authorizedAttempt({ ...args, c }) ||
      !repair().records(c.comments, 'worker-start').some(r => r.sha === expectedSha &&
        r.authorizationRun === String(args.authorizationRun) && r.runId === String(context.runId))) throw new Error('Stale or unapproved conflict resolution');
  if (git(cwd, 'rev-parse', 'HEAD').trim() !== c.baseSha) throw new Error('Conflict patch must apply to exact authorized main');
  const paths = applyPatch(cwd, patchPath, c.proof.metadata);
  if (!await preservedTargets({ github, context, proof: c.proof, cwd, base: c.baseSha })) throw new Error('Resolution reverted requested dependency versions');
  const tree = [];
  for (const path of paths) {
    const { data: blob } = await writerGithub.rest.git.createBlob({ ...context.repo,
      content: readFileSync(resolve(cwd, path)).toString('base64'), encoding: 'base64' });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const { data: base } = await writerGithub.rest.git.getCommit({ ...context.repo, commit_sha: c.baseSha });
  const { data: nextTree } = await writerGithub.rest.git.createTree({ ...context.repo, base_tree: base.tree.sha, tree });
  const { data: commit } = await writerGithub.rest.git.createCommit({ ...context.repo,
    message: `fix: resolve dependency update against main (#${c.pr.number})`, tree: nextTree.sha, parents: [expectedSha, c.baseSha] });
  const fresh = await candidate(args);
  if (!fresh || fresh.pr.head.sha !== expectedSha) throw new Error('PR or main changed during conflict resolution');
  await repair().record(github, context, c.pr.number, { kind: 'published', policy: 2, mode: 'conflict', sha: commit.sha,
    parent: expectedSha, base: c.baseSha, origin: c.proof.originalHead, originalBase: c.proof.originalBase, runId: String(context.runId) },
  '競合解消を反映します。必須CIとマージキューの統合テストが成功してから自動マージします。');
  await writerGithub.rest.git.updateRef({ ...context.repo, ref: `heads/${c.pr.head.ref}`, sha: commit.sha, force: false });
}
module.exports = { allowedFiles, provenance, candidate, scope, lockVersions, preservedTargets, applyPatch, publish };
