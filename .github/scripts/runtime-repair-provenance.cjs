// Trusted-main verification of runtime publications followed by bounded Claude repairs.
// App authorship alone never authorizes a follow-up commit.
const runtime = require('./runtime-pull-request.cjs');
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
async function provenance({ github, context, pr, files, comments, commits,
  bot = process.env.DEPENDENCY_BOT_LOGIN || 'videoq-dependency-bot[bot]', base }) {
  const repair = require('./claude-dependency-repair.cjs');
  if (!commits.length || commits.at(-1).sha !== pr.head.sha || files.length > 82) return null;
  for (const publication of runtime.receipts(comments, bot).filter(r => r.kind === 'publication').reverse()) {
    const index = commits.findIndex(commit => commit.sha === publication.sha);
    if (index < 0 || !sha(publication.base)) continue;
    const { data: original } = await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo, basehead: `${publication.base}...${publication.sha}`,
    });
    const originPR = { ...pr, head: { ...pr.head, sha: publication.sha } };
    if (!runtime.eligible(originPR, original.files || [], comments, bot, true) ||
      !await runtime.ownedCommits({ github, context, commits: commits.slice(0, index + 1), bot, base })) continue;
    const metadata = { ecosystem: 'runtime', paths: (original.files || []).map(file => file.filename) };
    const followups = commits.slice(index + 1);
    if (followups.length > repair.MAX_ATTEMPTS * 2) continue;
    let parent = publication.sha;
    let valid = true;
    for (const commit of followups) {
      const receipt = repair.records(comments, 'published').find(r => r.policy === 2 && ['ci', 'conflict'].includes(r.mode) &&
        r.sha === commit.sha && r.parent === parent && r.origin === publication.sha &&
        r.originalBase === publication.base && /^\d+$/.test(String(r.runId)));
      if (!receipt || JSON.stringify(commit.parents?.map(p => p.sha)) !== JSON.stringify(
        receipt.mode === 'conflict' ? [parent, receipt.base] : [parent])) { valid = false; break; }
      if (receipt.mode === 'conflict') {
        if (!sha(receipt.base)) { valid = false; break; }
        const { data: main } = await github.rest.repos.getBranch({ ...context.repo, branch: 'main' });
        const { data: ancestry } = await github.rest.repos.compareCommits({ ...context.repo, base: receipt.base, head: main.commit.sha });
        if (ancestry.merge_base_commit?.sha !== receipt.base) { valid = false; break; }
      }
      const { data: delta } = await github.rest.repos.compareCommitsWithBasehead({
        ...context.repo, basehead: `${receipt.mode === 'conflict' ? receipt.base : parent}...${commit.sha}`,
      });
      const resolution = require('./dependency-resolution.cjs');
      if (receipt.mode === 'ci' ? !await repair.validRepairDiff({ github, context, parent, head: commit.sha, diff: delta })
        : !resolution.allowedFiles(delta.files || [], metadata) ||
          !await resolution.preservedTargets({ github, context, proof: { originalHead: publication.sha, originalBase: publication.base, metadata }, ref: commit.sha, base: receipt.base })) { valid = false; break; }
      parent = commit.sha;
    }
    const originalPaths = new Set((original.files || []).map(file => file.filename));
    if (!valid || !files.every(file => originalPaths.has(file.filename) || repair.validRepairFiles([file]))) continue;
    return { originalHead: publication.sha, originalBase: publication.base, publication, metadata };
  }
  return null;
}
module.exports = { provenance };
