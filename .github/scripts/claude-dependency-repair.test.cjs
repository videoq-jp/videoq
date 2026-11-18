const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const p = require('./claude-dependency-repair.cjs');
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const repo = 'videoq-jp/videoq';
const metadata = { ecosystem: 'npm_and_yarn', updateType: 'version-update:semver-minor', maintainerChanges: 'false' };
const bot = (sha = A) => ({ sha, author: { login: 'dependabot[bot]' }, commit: { verification: { verified: true } } });
const comment = r => ({ user: { login: 'github-actions[bot]' }, body: '<!-- videoq-claude-dependency-v1 -->\n' + JSON.stringify(r) });
const seed = () => comment({ kind: 'seed', sha: A, metadata });
const receipt = (sha = B, parent = A) => comment({ kind: 'published', sha, parent, origin: A, runId: '77' });
const source = (filename = 'apps/web/src/components/player.tsx') => ({ filename, status: 'modified', patch: '-old\n+new', changes: 2 });

function fixture(repaired = false) {
  const f = { context: { repo: { owner: 'videoq-jp', repo: 'videoq' }, ref: 'refs/heads/main', runId: 77 }, runId: '99',
    pr: { number: 1, state: 'open', draft: false, node_id: 'PR_1', user: { login: 'dependabot[bot]' }, labels: [],
      head: { ref: 'dependabot/npm_and_yarn/update', sha: repaired ? B : A, repo: { full_name: repo } },
      base: { ref: 'main', sha: C, repo: { full_name: repo } } },
    comments: [seed()], commits: [bot()], original: [{ filename: 'package-lock.json', status: 'modified' }],
    diff: [source()], mutations: [], jobs: [...['Supply Chain Security', 'Deployment Security Tests'].map(name => ({ name, conclusion: 'success' })),
      { name: 'Hono (apps/api)', conclusion: repaired ? 'success' : 'failure' }],
    protection: { required_status_checks: { strict: true, checks: ['CI Success', 'Supply Chain Security'].map(context => ({ context, app_id: 15368 })) } },
  };
  if (repaired) { f.comments.push(receipt()); f.commits.push({ sha: B, parents: [{ sha: A }] }); }
  f.run = { id: 99, workflow_id: 42, event: 'pull_request', status: 'completed', conclusion: repaired ? 'success' : 'failure',
    repository: { full_name: repo }, head_repository: { full_name: repo }, head_branch: f.pr.head.ref, head_sha: f.pr.head.sha, run_attempt: 1 };
  f.latest = f.run;
  f.github = { paginate: (method, args) => method(args), graphql: async () => { f.mutations.push('disable'); f.pr.auto_merge = null; }, rest: {
    actions: { getWorkflowRun: async a => ({ data: String(a.run_id) === '77' ? {
      workflow_id: 43, repository: { full_name: repo }, head_repository: { full_name: repo }, head_branch: 'main', event: 'workflow_run',
    } : f.run }), getWorkflow: async a => ({ data: { id: a.workflow_id === 'ci.yml' ? 42 : a.workflow_id === 'dependency-queue.yml' ? 43 : 44 } }),
      listWorkflowRuns: async () => ({ data: { workflow_runs: [f.latest] } }), listJobsForWorkflowRun: async () => f.jobs },
    pulls: { list: async () => ({ data: [f.pr] }), get: async () => ({ data: f.pr }), listFiles: async () => f.original,
      listCommits: async () => f.commits },
    issues: { listComments: async () => f.comments, createComment: async a => { f.comments.push(comment(JSON.parse(a.body.split('\n')[1]))); f.mutations.push('comment'); } },
    repos: { compareCommitsWithBasehead: async a => ({ data: { total_commits: 1, files: a.basehead.endsWith('...' + A) ? f.original : f.diff } }),
      getBranchProtection: async () => ({ data: f.protection }) },
  } };
  f.writerGithub = f.github;
  return f;
}

test('only a contiguous receipt-backed repair chain can inherit verified Dependabot metadata', () => {
  const f = fixture(true);
  assert.ok(p.chain(f.commits, f.comments));
  for (const mutate of [
    f => { f.comments[1].user.login = 'owner'; },
    f => { f.commits[1].parents = [{ sha: C }]; },
    f => { f.commits[0].commit.verification.verified = false; },
    f => { f.commits.push({ sha: C, parents: [{ sha: B }] }); },
  ]) { const bad = fixture(true); mutate(bad); assert.equal(p.chain(bad.commits, bad.comments), null); }
});
test('compatibility scope includes configs, tests and types but excludes automation, dependencies and credentials', () => {
  for (const path of ['apps/web/vite.config.ts', 'apps/web/vite.config.mts', 'apps/api/wrangler.jsonc', 'apps/web/.storybook/vite.config.ts', 'apps/web/src/x.test.ts', 'apps/web/src/__tests__/x.ts', 'apps/web/src/types.d.ts', 'apps/api/src/auth/session.ts', 'apps/api/src/db/migrations/migrate.ts']) assert.equal(p.validRepairFiles([source(path)]), true, path);
  assert.equal(p.validRepairFiles([source()]), true);
  for (const filename of ['.github/workflows/ci.yml', 'package.json',
    'apps/web/src/../../config.ts', 'apps/worker/worker_python/env.py', 'apps/worker/worker_python/secrets_bootstrap.py',
    'infra/iam.tf', '.github/scripts/dependency-resolution.cjs']) {
    assert.equal(p.validRepairFiles([source(filename)]), false, filename);
  }
  for (const files of [[], [source(), { ...source(), status: 'removed' }], [{ ...source(), patch: undefined }],
    [{ ...source(), changes: 2001 }], Array.from({ length: 33 }, () => source())]) assert.equal(p.validRepairFiles(files), false);
});
test('current failed originals and successful repaired heads are eligible', async () => {
  assert.ok(await p.candidate(fixture()));
  const f = fixture(true);
  assert.ok(await p.candidate(f));
});
for (const [name, mutate] of [
  ['fork', f => { f.pr.head.repo.full_name = 'attacker/repo'; }],
  ['unsupported ecosystem', f => { f.comments[0] = comment({ kind: 'seed', sha: A, metadata: { ...metadata, ecosystem: 'terraform' } }); }],
  ['stale head', f => { f.pr.head.sha = C; }],
  ['new CI', f => { f.latest = { ...f.run, id: 100 }; }],
  ['new attempt', f => { f.latest = { ...f.run, run_attempt: 2 }; }],
  ['wrong workflow', f => { f.run.workflow_id = 100; }],
  ['human commit', f => { f.commits.push({ sha: B }); f.pr.head.sha = B; f.run.head_sha = B; }],
  ['no-claude', f => { f.pr.labels.push({ name: 'no-claude' }); }],
  ['no-automerge', f => { f.pr.labels.push({ name: 'no-automerge' }); }],
  ['untrusted seed', f => { f.comments[0].user.login = 'owner'; }],
  ['original source change', f => { f.original.push(source()); }],
]) test(`candidate rejects ${name}`, async () => { const f = fixture(); mutate(f); assert.equal(await p.candidate(f), null); });

test('a receipt does not authorize a forbidden patch', async () => {
  const f = fixture(true); f.diff = [source('.github/workflows/ci.yml')];
  assert.equal(await p.candidate(f), null);
});
test('attempts are durable, deduplicated by SHA, and bounded across CI reruns', async () => {
  const f = fixture(); f.pr.auto_merge = {};
  assert.deepEqual(await p.scope(f), { number: 1, sha: A, branch: f.pr.head.ref, origin: A });
  assert.equal(f.mutations[0], 'disable');
  assert.equal(await p.scope(f), null);
  assert.equal(p.records(f.comments, 'stopped').length, 0);
  f.run.run_attempt = 2;
  assert.equal(await p.scope(f), null);
  assert.equal(p.records(f.comments, 'attempt').length, 1);
  const repaired = fixture(true); repaired.run.conclusion = 'failure';
  repaired.jobs.push({ name: 'Frontend Build', conclusion: 'failure' });
  for (let index = 0; index < p.MAX_ATTEMPTS; index++) repaired.comments.push(comment({ kind: 'attempt', policy: 2, sha: index.toString().repeat(40) }));
  assert.equal(await p.scope(repaired), null);
});
test('security failures stop before invoking Claude', async () => {
  const f = fixture(); f.jobs[0].conclusion = 'failure';
  assert.equal(await p.scope(f), null);
  assert.equal(p.records(f.comments, 'attempt').length, 0);
  assert.equal(p.records(f.comments, 'security-stop').length, 1);
});
test('coverage upload failures and aggregate failures cannot consume source repair attempts', async () => {
  const f = fixture();
  f.jobs = f.jobs.filter(job => job.conclusion === 'success');
  f.jobs.push({ name: 'Frontend Coverage', conclusion: 'failure' }, { name: 'CI Success', conclusion: 'failure' });
  assert.equal(await p.scope(f), null);
  assert.equal(p.records(f.comments, 'attempt').length, 0);
});
test('an actual application failure can be repaired while coverage reporting is unavailable', async () => {
  const f = fixture(); f.jobs.push({ name: 'Frontend Coverage', conclusion: 'failure' });
  assert.equal((await p.scope(f)).sha, A);
  assert.equal(p.records(f.comments, 'attempt').length, 1);
});
test('repair preparation cancels auto-merge with the App while keeping records on the standard token', async () => {
  const f = fixture(); f.pr.auto_merge = {};
  f.github.graphql = async () => { throw new Error('Resource not accessible by integration'); };
  let disabled = false;
  f.writerGithub = { graphql: async () => { disabled = true; f.pr.auto_merge = null; } };
  assert.ok(await p.scope(f));
  assert.equal(disabled, true);
  assert.equal(p.records(f.comments, 'attempt').length, 1);
  const failure = fixture(); failure.pr.auto_merge = {};
  failure.writerGithub = { graphql: async () => { throw new Error('App unavailable'); } };
  await assert.rejects(p.scope(failure), /App unavailable/);
  assert.equal(p.records(failure.comments, 'attempt').length, 0);
});
test('fresh checkout validates real patches including file modes and line limits', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-repair-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  git('init', '--quiet'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  mkdirSync(join(cwd, 'apps/web/src'), { recursive: true });
  const path = join(cwd, 'apps/web/src/player.ts'); writeFileSync(path, 'export const player = 1;\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'initial');
  writeFileSync(path, 'export const player = 2;\n');
  const patch = join(cwd, 'repair.patch'); writeFileSync(patch, git('diff'));
  git('restore', 'apps/web/src/player.ts');
  assert.deepEqual(p.applyPatch(cwd, patch), ['apps/web/src/player.ts']);
  assert.match(readFileSync(path, 'utf8'), /= 2/);
  git('restore', '--staged', 'apps/web/src/player.ts'); git('restore', 'apps/web/src/player.ts');
  writeFileSync(patch, 'diff --git a/apps/web/src/player.ts b/apps/web/src/player.ts\nold mode 100644\nnew mode 100755\n');
  assert.throws(() => p.applyPatch(cwd, patch), /Forbidden repair path or mode/);
});
test('workflow keeps model access read-only and publishing isolated', () => {
  const workflow = readFileSync(join(__dirname, '../workflows/dependency-queue.yml'), 'utf8');
  const worker = readFileSync(join(__dirname, '../workflows/claude-dependency-worker.yml'), 'utf8');
  const repair = worker.split('\n  repair:')[1].split('\n  publish:')[0];
  assert.doesNotMatch(repair, /PATCH_BOT_PRIVATE_KEY|contents: write|pull-requests: write/);
  assert.match(repair, /persist-credentials: false/);
  assert.match(worker, /workflow_dispatch:/);
  assert.match(repair, /Revalidate the trusted repair authorization/);
  for (const action of (workflow + worker).matchAll(/uses: ([^\s]+)/g)) {
    if (!action[1].startsWith('./')) assert.match(action[1], /@[a-f0-9]{40}$/);
  }
  assert.match(readFileSync(join(__dirname, 'native-dependency-queue.cjs'), 'utf8'), /expectedHeadOid:\$sha/);
  assert.match(worker, /group: dependency-automation-\$\{\{ inputs\.number \}\}/);
});

for (const kind of ['dependabot', 'runtime']) test(`${kind} publication uses a separate writer, records exact parent, and never force pushes`, async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-publish-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  git('init', '--quiet'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  mkdirSync(join(cwd, 'apps/web/src'), { recursive: true });
  const path = join(cwd, 'apps/web/src/player.ts'); writeFileSync(path, 'export const player = 1;\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'initial');
  writeFileSync(path, 'export const player = 2;\n');
  const patchPath = join(cwd, 'repair.patch'); writeFileSync(patchPath, git('diff'));
  git('restore', 'apps/web/src/player.ts');
  const f = kind === 'runtime' ? runtimeFixture() : fixture();
  f.comments.push(comment({ kind: 'attempt', sha: A, runId: '77' }));
  f.comments.push(comment({ kind: 'worker-start', sha: A, runId: '77', authorizationRun: '77' }));
  const calls = [];
  f.writerGithub = { rest: {
    pulls: f.github.rest.pulls,
    git: {
      createBlob: async a => { calls.push(['blob', a]); return { data: { sha: C } }; },
      getCommit: async () => ({ data: { tree: { sha: C } } }),
      createTree: async a => { calls.push(['tree', a]); return { data: { sha: C } }; },
      createCommit: async a => { calls.push(['commit', a]); return { data: { sha: B } }; },
      updateRef: async a => { assert.equal(p.records(f.comments, 'published')[0].sha, B); calls.push(['push', a]); },
    },
  } };
  await p.publish({ ...f, cwd, patchPath, expectedSha: A, authorizationRun: '77' });
  assert.deepEqual(calls.find(([name]) => name === 'commit')[1].parents, [A]);
  assert.equal(calls.find(([name]) => name === 'push')[1].force, false);
  assert.equal(calls.find(([name]) => name === 'tree')[1].tree[0].path, 'apps/web/src/player.ts');
  assert.match(Buffer.from(calls[0][1].content, 'base64').toString(), /player = 2/);
  const stale = fixture();
  await assert.rejects(p.publish({ ...stale, cwd, patchPath, expectedSha: B }), /Stale or unapproved/);
});

test('worker execution requires a real coordinator run and is claimed only once', async () => {
  const f = fixture();
  f.comments.push(comment({ kind: 'attempt', sha: A, runId: '77' }));
  const args = { ...f, expectedSha: A, authorizationRun: '77', number: 1 };
  await p.claimWorker(args);
  await assert.rejects(p.claimWorker(args), /already claimed/);
  const bad = fixture();
  bad.comments.push(comment({ kind: 'attempt', sha: A, runId: '99' }));
  assert.equal(await p.authorizedAttempt({ ...bad, c: await p.candidate(bad), authorizationRun: '99' }), false);
});
test('only main runs of the single controller can authorize a worker; retired routes and PR events are rejected', async () => {
  for (const event of ['push', 'workflow_run', 'workflow_dispatch', 'pull_request_target']) {
    const f = fixture(); f.comments.push(comment({ kind: 'attempt', sha: A, runId: '77' }));
    const c = await p.candidate(f);
    f.github.rest.actions.getWorkflowRun = async () => ({ data: { workflow_id: 43, event,
      repository: { full_name: repo }, head_repository: { full_name: repo }, head_branch: 'main' } });
    assert.equal(await p.authorizedAttempt({ ...f, c, authorizationRun: '77' }), event !== 'pull_request_target');
    f.github.rest.actions.getWorkflowRun = async () => ({ data: { workflow_id: 44, event: 'workflow_run',
      repository: { full_name: repo }, head_repository: { full_name: repo }, head_branch: 'main' } });
    assert.equal(await p.authorizedAttempt({ ...f, c, authorizationRun: '77' }), false);
  }
});
test('the controller verifies a failed head and records authorization before dispatching the isolated worker', async () => {
  const f = fixture(); const dispatches = [];
  f.github.rest.actions.createWorkflowDispatch = async args => {
    assert.equal(p.records(f.comments, 'attempt')[0].sha, A);
    dispatches.push(args);
  };
  await require('./dependency-queue.cjs').repairFailure(f);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].workflow_id, 'claude-dependency-worker.yml');
  assert.deepEqual(dispatches[0].inputs, { number: '1', sha: A, run_id: '99', authorization_run: '77' });
});

test('major npm updates receive the same repair path as minor updates', async () => {
  const f = fixture(); f.comments[0] = comment({ kind: 'seed', sha: A, metadata: { ...metadata, updateType: 'version-update:semver-major' } });
  assert.ok(await p.candidate(f)); assert.ok(await p.scope(f));
});

test('unified infrastructure checks and aggregate wrappers do not spend Claude application-repair attempts', async () => {
  for (const name of ['Container Validation', 'Terraform Plan', 'container-checks / Worker image security (ARM64)', 'terraform-checks / Terraform Plan (AWS)', 'operations-fixture']) {
    const f = fixture(); f.jobs = f.jobs.filter(job => job.conclusion === 'success');
    f.jobs.push({ name, conclusion: 'failure' }, { name: 'CI Success', conclusion: 'failure' });
    assert.equal(await p.scope(f), null, name);
    assert.equal(p.attempts(f.comments).length, 0);
  }
  const mixed = fixture(); mixed.jobs.push({ name: 'Terraform Plan', conclusion: 'failure' });
  assert.equal((await p.scope(mixed)).sha, A);
});

test('exhausted CI attempts report once before the dispatch gate and link the completed worker', async () => {
  const f = fixture();
  for (let i = 0; i < p.MAX_ATTEMPTS; i++) f.comments.push(comment({ kind: 'attempt', policy: 2, mode: 'ci', sha: A }));
  f.comments.push(comment({ kind: 'worker-start', runId: '99' }));
  const create = f.github.rest.issues.createComment; const messages = [];
  f.github.rest.issues.createComment = async args => { messages.push(args.body); return create(args); };
  assert.equal(await p.scope(f), null);
  assert.equal(await p.scope(f), null);
  assert.equal(p.records(f.comments, 'stopped').length, 1);
  assert.equal(p.records(f.comments, 'attempt').length, 8);
  assert.match(messages[0], /actions\/runs\/99/);
  assert.match(messages[0], /pull\/1\/checks/);
});

test('final attempt still running is not announced as stopped; modes and untrusted receipts are independent', async () => {
  const f = fixture();
  const args = { ...f, comments: f.comments };
  for (let i = 0; i < p.MAX_ATTEMPTS; i++) f.comments.push(comment({ kind: 'attempt', policy: 2, mode: 'conflict', sha: A }));
  assert.equal(await p.stopIfExhausted(args), false);
  f.comments.push(comment({ kind: 'worker-start', runId: '99' }));
  f.run.status = 'in_progress';
  assert.equal(await p.stopIfExhausted({ ...args, mode: 'conflict' }), false);
  assert.equal(p.records(f.comments, 'stopped').length, 0);
  f.run.status = 'completed';
  assert.equal(await p.stopIfExhausted({ ...args, mode: 'conflict' }), true);
  assert.equal(p.records(f.comments, 'stopped')[0].mode, 'conflict');
  const fake = f.comments.map(c => ({ ...c, user: { login: 'maintainer' } }));
  assert.equal(await p.stopIfExhausted({ ...args, comments: fake, mode: 'conflict' }), false);
});

test('unsupported infrastructure failures report once without spending Claude attempts', async () => {
  const f = fixture();
  f.jobs = [ { name: 'Supply Chain Security', conclusion: 'success' },
    { name: 'Deployment Security Tests', conclusion: 'success' },
    { name: 'terraform-checks / Terraform Plan (AWS)', conclusion: 'failure' } ];
  assert.equal(await p.scope(f), null); assert.equal(await p.scope(f), null);
  assert.equal(p.records(f.comments, 'unsupported-stop').length, 1);
  assert.equal(p.records(f.comments, 'attempt').length, 0);
});

function runtimeFixture(repaired = false, channel = 'current') {
  const f = fixture(repaired);
  f.pr.user.login = 'videoq-dependency-bot[bot]';
  f.pr.head.ref = `runtime/node-${channel}`;
  f.run.head_branch = f.pr.head.ref;
  f.commits[0].author.login = f.pr.user.login;
  f.original = [{ filename: '.node-version', status: 'modified', patch: '-26.12.0\n+26.12.1', changes: 2 }];
  f.comments = [{ user: { login: f.pr.user.login }, body: '<!-- videoq-runtime-update-v1 -->\n' + JSON.stringify({
    kind: 'publication', sha: A, base: C, runtime: 'node', channel,
    previous_version: '26.12.0', version: channel === 'current' ? '26.12.1' : '28.0.0',
  }) }];
  if (repaired) f.comments.push(comment({ kind: 'published', policy: 2, mode: 'ci', sha: B, parent: A, origin: A, originalBase: C, runId: '77' }));
  f.github.rest.pulls.listFiles = async () => repaired ? [...f.original, ...f.diff] : f.original;
  f.github.rest.repos.getBranch = async () => ({ data: { commit: { sha: C } } });
  f.github.rest.repos.compareCommits = async () => ({ data: { merge_base_commit: { sha: C } } });
  return f;
}
test('both runtime channels authorize Claude from a trusted publication without a Dependabot seed', async () => {
  for (const channel of ['current', 'next']) {
    const f = runtimeFixture(false, channel), dispatches = [];
    f.github.rest.actions.createWorkflowDispatch = async args => dispatches.push(args);
    assert.ok(await p.candidate(f));
    await require('./dependency-queue.cjs').repairFailure(f);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].inputs.sha, A);
    assert.equal(p.records(f.comments, 'attempt').length, 1);
    await p.claimWorker({ ...f, expectedSha: A, authorizationRun: '77', number: 1 });
    await assert.rejects(p.claimWorker({ ...f, expectedSha: A, authorizationRun: '77', number: 1 }), /already claimed/);
  }
});
test('runtime repairs retain provenance for retries and queue admission; next remains manual', async () => {
  for (const channel of ['current', 'next']) {
    const f = runtimeFixture(true, channel);
    assert.ok(await p.candidate(f));
    const c = await require('./dependency-queue.cjs').verified({ ...f, pr: f.pr });
    assert.equal(c.kind, 'runtime');
    assert.equal(c.autoQueue, channel === 'current');
    assert.equal(c.proof.originalHead, A);
    assert.equal(c.proof.originalBase, C);
  }
});
for (const [name, mutate] of [
  ['forged publication', f => { f.comments[0].user.login = 'human'; }],
  ['fork', f => { f.pr.head.repo.full_name = 'fork/videoq'; }],
  ['unknown branch', f => { f.pr.head.ref = 'runtime/unmanaged'; }],
  ['human original', f => { f.commits[0].author.login = 'human'; }],
  ['missing repair receipt', f => { f.comments.pop(); }],
  ['forged repair receipt', f => { f.comments[1].user.login = 'human'; }],
  ['wrong parent', f => { f.commits[1].parents = [{ sha: C }]; }],
  ['forbidden repair', f => { f.diff = [source('.github/workflows/ci.yml')]; }],
  ['changed origin base', f => { f.comments[1] = comment({ kind: 'published', policy: 2, mode: 'ci', sha: B, parent: A, origin: A, originalBase: B, runId: '77' }); }],
  ['no-runtime-update', f => { f.pr.labels.push({ name: 'no-runtime-update' }); }],
  ['no-claude', f => { f.pr.labels.push({ name: 'no-claude' }); }],
]) test(`runtime repair rejects ${name}`, async () => {
  const f = runtimeFixture(true); mutate(f); assert.equal(await p.candidate(f), null);
});

test('runtime conflicts retain exact main parents and verified requested pins across later CI repairs', async () => {
  const resolution = require('./dependency-resolution.cjs'), D = 'd'.repeat(40);
  const fresh = runtimeFixture(); fresh.pr.mergeable = false;
  const args = { ...fresh, mode: 'conflict', number: 1, baseSha: C };
  assert.ok(await resolution.candidate(args));
  assert.equal((await resolution.scope(args)).baseSha, C);
  const f = runtimeFixture(true);
  f.commits[1].parents = [{ sha: A }, { sha: D }];
  f.comments[1] = comment({ kind: 'published', policy: 2, mode: 'conflict', sha: B, parent: A, base: D, origin: A, originalBase: C, runId: '77' });
  f.github.rest.repos.getBranch = async () => ({ data: { commit: { sha: D } } });
  f.github.rest.repos.compareCommits = async () => ({ data: { merge_base_commit: { sha: D } } });
  let proposed = '26.12.1\n';
  f.github.rest.repos.getContent = async ({ ref }) => ({ data: { type: 'file', encoding: 'base64',
    content: Buffer.from(ref === A ? '26.12.1\n' : ref === B ? proposed : '26.12.0\n').toString('base64') } });
  assert.ok(await p.candidate(f));
  proposed = '26.12.0\n'; assert.equal(await p.candidate(f), null);
  proposed = '26.12.1\ninvented-command\n'; assert.equal(await p.candidate(f), null);
  proposed = '26.12.1\n';
  f.github.rest.repos.compareCommits = async () => ({ data: { merge_base_commit: { sha: C } } });
  assert.equal(await p.candidate(f), null);
});

test('container compatibility repairs preserve image pins and entire verified installation blocks', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-container-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '--quiet'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  mkdirSync(join(cwd, 'apps/worker'), { recursive: true });
  const path = 'apps/worker/Dockerfile.onprem';
  const original = 'FROM python:3.14@sha256:' + 'a'.repeat(64) + '\n# BEGIN managed pip\nRUN verify-the-download\n# END managed pip\nRUN python -m old-command\n';
  writeFileSync(join(cwd, path), original); git('add', '.'); git('commit', '--quiet', '-m', 'initial');
  const patchPath = join(cwd, 'repair.patch');
  const publish = after => {
    writeFileSync(join(cwd, path), after); writeFileSync(patchPath, git('diff'));
    git('restore', '--', path); return p.applyPatch(cwd, patchPath);
  };
  assert.deepEqual(publish(original.replace('old-command', 'new-command')), [path]);
  git('restore', '--staged', '--', path); git('restore', '--', path);
  assert.throws(() => publish(original.replace('python:3.14', 'python:3.15')), /protected pins/);
  git('restore', '--staged', '--', path); git('restore', '--', path);
  assert.throws(() => publish(original.replace('verify-the-download', 'skip-verification')), /protected pins/);
  const diff = { total_commits: 1, files: [source(path)] };
  const github = { rest: { repos: { getContent: async ({ ref }) => ({ data: { type: 'file', encoding: 'base64',
    content: Buffer.from(ref === A ? original : original.replace('verify-the-download', 'skip-verification')).toString('base64') } }) } } };
  assert.equal(await p.validRepairDiff({ github, context: { repo: {} }, parent: A, head: B, diff }), false);
  assert.equal(p.validRepairFiles([{ ...source(path), patch: '-FROM python:3.14\n+FROM python:3.15' }]), false);
});

test('scheduled runtime regeneration preserves verified Claude repairs instead of overwriting them', async () => {
  const f = runtimeFixture(true);
  f.commits[1].author = { login: f.pr.user.login };
  f.github.rest.git = { getRef: async ({ ref }) => ({ data: { object: { sha: ref === 'heads/main' ? C : B } } }) };
  const number = await require('./runtime-pull-request.cjs').publish({ github: f.github,
    context: { ...f.context, sha: C, eventName: 'schedule' }, bot: f.pr.user.login,
    core: { info() {} }, plan: { changed: true, runtime: 'node', channel: 'current', previous_version: '26.12.0', version: '26.12.1', files: { '.node-version': '26.12.1\n' } } });
  assert.equal(number, 1);
  assert.deepEqual(f.mutations, []);
});

test('a Dependabot package update retains provenance after a container compatibility repair', async () => {
  const f = fixture(true);
  f.commits[0].parents = [{ sha: C }];
  f.commits[0].commit.message = 'update\n---\nupdated-dependencies:\n- dependency-name: example\n  update-type: version-update:semver-minor\n...\n';
  f.original[0] = { ...f.original[0], patch: '-old\n+new', changes: 2 };
  f.diff = [source('apps/worker/Dockerfile.onprem')];
  const original = 'FROM python:3.14\nRUN old-command\n';
  f.github.rest.repos.getContent = async ({ ref }) => ({ data: { type: 'file', encoding: 'base64',
    content: Buffer.from(ref === A ? original : original.replace('old-command', 'new-command')).toString('base64') } });
  const proof = await require('./dependency-rebase.cjs').provenance({ ...f,
    files: [...f.original, ...f.diff] });
  assert.equal(proof.metadata.ecosystem, 'npm_and_yarn');
  assert.equal(proof.originalHead, B);
  assert.ok(await p.candidate(f));
});
