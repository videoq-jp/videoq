// Always load this module from github.workflow_sha, never from a PR checkout.
const REPOSITORY = 'videoq-jp/videoq';
const BOT = 'dependabot[bot]';
const REQUEST_MARKER = '<!-- videoq-codex-repair-request -->';
const manifests = new Set([
  'package.json', 'package-lock.json',
  'apps/api/package.json', 'apps/web/package.json', 'apps/docs/package.json',
  'apps/demo-video/package.json', 'packages/trpc/package.json',
  'apps/worker/pyproject.toml', 'apps/worker/uv.lock',
  'apps/inference/whisper/pyproject.toml', 'apps/inference/whisper/uv.lock',
]);

// Scope each verified ecosystem to its own dependency files.
const ecosystemFiles = {
  npm_and_yarn: [
    'package.json', 'package-lock.json',
    'apps/api/package.json', 'apps/web/package.json', 'apps/docs/package.json',
    'apps/demo-video/package.json', 'packages/trpc/package.json',
  ],
  pip: ['apps/worker/pyproject.toml', 'apps/worker/uv.lock'],
  uv: ['apps/worker/pyproject.toml', 'apps/worker/uv.lock',
    'apps/inference/whisper/pyproject.toml', 'apps/inference/whisper/uv.lock'],
  docker: [
    'apps/api/Dockerfile', 'apps/api/Dockerfile.local', 'apps/web/Dockerfile', 'apps/web/Dockerfile.dev',
    'apps/worker/Dockerfile', 'apps/worker/Dockerfile.local', 'apps/worker/Dockerfile.onprem',
    'apps/inference/whisper/Dockerfile',
  ],
  docker_compose: ['docker-compose.yml'],
  'docker-compose': ['docker-compose.yml'],
  terraform: [
    'infra/versions.tf', 'infra/.terraform.lock.hcl',
    'infra/bootstrap/main.tf', 'infra/bootstrap/.terraform.lock.hcl',
    'infra/db-maintenance/terraform/versions.tf', 'infra/db-maintenance/terraform/.terraform.lock.hcl',
  ],
};
const workflowFile = /^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/;

function dependencyFile(file, ecosystem) {
  return file.status === 'modified' && (ecosystem === 'github_actions'
    ? workflowFile.test(file.filename)
    : ecosystemFiles[ecosystem]?.includes(file.filename) === true);
}

function actionPinsOnly(files) {
  return files.every(file => {
    if (!file.patch) return false;
    const pins = { '-': [], '+': [] };
    for (const line of file.patch.split('\n')) {
      if (!['-', '+'].includes(line[0])) continue;
      const match = line.slice(1).match(/^(\s*(?:-\s*)?uses:\s*)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+)@[a-f0-9]{40}(?:\s*#.*)?\s*$/);
      if (!match) return false;
      pins[line[0]].push(match[1] + match[2]);
    }
    return pins['-'].length > 0 && JSON.stringify(pins['-']) === JSON.stringify(pins['+']);
  });
}

function terraformVersionsOnly(files) {
  return files.every(file => {
    if (file.filename.endsWith('/.terraform.lock.hcl')) return true;
    if (!file.patch) return false;
    const changed = file.patch.split('\n').filter(line => ['-', '+'].includes(line[0]));
    return changed.length > 0 && changed.every(line => /^\s*version\s*=\s*"[^"\r\n]+"\s*(?:#.*)?$/.test(line.slice(1)));
  });
}

function isRepairRequest(comment) {
  return comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(REQUEST_MARKER);
}

function eligiblePull(pr, files, optOut, comments = [], state = 'open') {
  const merge = optOut === 'no-automerge';
  return pr.state === state && !pr.draft &&
    pr.user?.login === BOT && pr.head?.repo?.full_name === REPOSITORY &&
    pr.base?.repo?.full_name === REPOSITORY && pr.base.ref === 'main' &&
    pr.head.ref.startsWith('dependabot/') && /^[a-f0-9]{40}$/.test(pr.head.sha) &&
    !pr.labels.some(label => label.name === optOut) &&
    files.length > 0 && files.length <= (merge ? 50 : 10) &&
    files.every(file => merge
      ? ['github_actions', ...Object.keys(ecosystemFiles)].some(ecosystem => dependencyFile(file, ecosystem))
      : file.status === 'modified' && manifests.has(file.filename));
}

function autoMergeMetadata(metadata, files) {
  return ['version-update:semver-patch', 'version-update:semver-minor', 'version-update:semver-major'].includes(metadata.updateType) &&
    metadata.maintainerChanges === 'false' &&
    files.length > 0 && files.length <= 50 &&
    files.every(file => dependencyFile(file, metadata.ecosystem)) &&
    (metadata.ecosystem !== 'github_actions' || actionPinsOnly(files)) &&
    (metadata.ecosystem !== 'terraform' || terraformVersionsOnly(files));
}

function verifiedDependencyCommits(commits, sha) {
  return commits.length > 0 && commits.at(-1).sha === sha &&
    commits.every(commit => commit.author?.login === BOT && commit.commit?.verification?.verified === true);
}

async function getPull({ github, context, number }) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPOSITORY) throw new Error('Unexpected repository.');
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  const files = await github.paginate(github.rest.pulls.listFiles, { ...context.repo, pull_number: number, per_page: 100 });
  const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: number, per_page: 100 });
  return { pr, files, comments };
}

module.exports = { verifiedDependencyCommits, eligiblePull, getPull, autoMergeMetadata, isRepairRequest };
