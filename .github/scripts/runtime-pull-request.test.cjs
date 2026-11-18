const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { validate, publish, eligible, sameLine, scope, ownedCommits } = require('./runtime-pull-request.cjs');

const plan = () => ({ changed: true, runtime: 'node', channel: 'current', previous_version: '26.12.0', version: '26.12.1', files: { '.node-version': '26.12.1\n' } });
const context = { ref: 'refs/heads/main', sha: 'a'.repeat(40), eventName: 'schedule', repo: { owner: 'videoq-jp', repo: 'videoq' } };
test('main ancestry distinguishes inherited commits from edits on the runtime branch', async () => {
  const bot = 'runtime-bot[bot]', inherited = 'b'.repeat(40), human = 'c'.repeat(40);
  const comparisons = [];
  const github = { rest: { repos: { compareCommits: async args => {
    comparisons.push(args);
    return { data: { merge_base_commit: { sha: args.base === inherited ? inherited : context.sha } } };
  } } } };
  const args = { github, context, bot, base: context.sha };
  assert.equal(await ownedCommits({ ...args, commits: [{ author: { login: bot } }, { sha: inherited, author: { login: 'dependabot[bot]' } }] }), true);
  assert.equal(await ownedCommits({ ...args, commits: [{ sha: human, author: { login: 'human' } }] }), false);
  assert.equal(await ownedCommits({ ...args, commits: [] }), false);
  assert.equal(comparisons[0].head, context.sha);
});
test('runtime PRs cannot write workflows, application code, credentials, or arbitrary paths', () => {
  for (const path of ['.github/workflows/cd.yml', 'apps/api/src/lib/auth.ts', '.env', '../outside', 'infra/variables.tf']) {
    const candidate = plan(); candidate.files[path] = 'untrusted';
    assert.throws(() => validate(candidate));
  }
  for (const runtime of ['node;echo bad', 'python\nother']) {
    assert.throws(() => validate({ ...plan(), runtime }));
  }
});
test('runtime publication refuses pull requests and other repositories before any API call', async () => {
  for (const invalid of [{ ...context, ref: 'refs/pull/1/merge' }, { ...context, eventName: 'pull_request_target' }, { ...context, repo: { owner: 'someone', repo: 'videoq' } }]) {
    await assert.rejects(publish({ github: {}, context: invalid, plan: plan(), bot: 'runtime-bot[bot]' }));
  }
});
test('a stale main source cannot create a runtime branch', async () => {
  const github = { rest: { git: { getRef: async () => ({ data: { object: { sha: 'b'.repeat(40) } } }) } } };
  await assert.rejects(publish({ github, context, plan: plan(), bot: 'runtime-bot[bot]' }), /Main changed/);
});
test('human edits in an existing runtime PR are preserved', async () => {
  const github = { rest: { git: { getRef: async ({ ref }) => ({ data: { object: { sha: ref === 'heads/main' ? context.sha : 'c'.repeat(40) } } }) },
    pulls: { list: async () => ({ data: [{ number: 1, user: { login: 'runtime-bot[bot]' }, head: { sha: 'c'.repeat(40) } }] }) } },
    paginate: async () => [{ author: { login: 'human' } }] };
  await assert.rejects(publish({ github, context, plan: plan(), bot: 'runtime-bot[bot]' }), /human changes/);
});
test('runtime discovery never executes PR code or receives production credentials', () => {
  const workflow = readFileSync(join(__dirname, '../workflows/runtime-updates.yml'), 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_target:|id-token: write|environment:|secrets\.(?!PATCH_BOT_PRIVATE_KEY)/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /permission-contents: write/);
  assert.doesNotMatch(workflow, /permission-workflows:/);
  const guard = readFileSync(join(__dirname, '../workflows/dependency-queue.yml'), 'utf8');
  assert.match(guard, /ref: refs\/heads\/main/);
  assert.doesNotMatch(guard, /ref:.*\$\{\{.*(?:head|pull_request)|npm ci|pip install|runtime-versions.py plan/);
});
function publicationFixture() {
  const writes = [];
  const github = { rest: {
    git: {
      getRef: async ({ ref }) => {
        if (ref === 'heads/main') return { data: { object: { sha: context.sha } } };
        throw Object.assign(new Error('not found'), { status: 404 });
      },
      createBlob: async (value) => { writes.push(['blob', value]); return { data: { sha: 'blob' } }; },
      getCommit: async () => ({ data: { tree: { sha: 'base-tree' } } }),
      createTree: async (value) => { writes.push(['tree', value]); return { data: { sha: 'next-tree' } }; },
      createCommit: async (value) => { writes.push(['commit', value]); return { data: { sha: 'new-commit' } }; },
      createRef: async (value) => { writes.push(['ref', value]); },
    },
    pulls: {
      list: async () => ({ data: [] }),
      create: async (value) => { writes.push(['pr', value]); return { data: { number: 123 } }; },
    },
    issues: { createComment: async value => writes.push(['receipt', value]) },
  } };
  return { github, writes };
}
test('a new runtime proposal writes an isolated branch and opens a PR without merging', async () => {
  const { github, writes } = publicationFixture();
  assert.equal(await publish({ github, context, core: { info() {} }, plan: plan(), bot: 'runtime-bot[bot]' }), 123);
  assert.equal(writes.find(([kind]) => kind === 'ref')[1].ref, 'refs/heads/runtime/node-current');
  assert.deepEqual(writes.find(([kind]) => kind === 'commit')[1].parents, [context.sha]);
  assert.equal(writes.find(([kind]) => kind === 'pr')[1].base, 'main');
  assert.equal(writes.find(([kind]) => kind === 'pr')[1].head, 'runtime/node-current');
  assert.match(writes.find(([kind]) => kind === 'receipt')[1].body, /videoq-runtime-update-v1/);
});
test('publication records exact provenance but never makes a merge decision', async () => {
  for (const channel of ['current', 'next']) {
    const f = publicationFixture();
    const proposal = { ...plan(), channel, version: channel === 'next' ? '28.0.0' : '26.12.1' };
    await publish({ ...f, context, core: { info() {} }, plan: proposal, bot: 'runtime-bot[bot]', retireSuperseded: true });
    assert.ok(f.writes.some(([kind]) => kind === 'receipt'));
    assert.equal(f.writes.some(([kind]) => kind === 'queue' || kind === 'disable'), false);
  }
  assert.throws(() => validate({ ...plan(), version: '28.0.0' }), /Invalid/);
});

test('all generated on-prem pins can be published together', () => {
  assert.doesNotThrow(() => validate({ ...plan(), files: {
    '.github/runtime-versions.json': '{}', 'apps/api/Dockerfile': 'FROM node',
    'apps/worker/Dockerfile.onprem': 'FROM python',
  } }));
});
test('automatic runtime merges exclude new series, downgrades, missing metadata and untrusted edits', () => {
  for (const [runtime, before, after, expected] of [
    ['node', '26.12.1', '26.13.0', true], ['node', '26.12.1', '28.0.0', false],
    ['python', '3.14.9', '3.14.10', true], ['python', '3.14.9', '3.15.0', false],
    ['uv', '0.13.5', '0.13.6', true], ['uv', '0.13.5', '0.14.0', false],
    ['npm', '12.2.1', '12.2.1', true], ['pip', '26.2.2', '26.2.1', false],
  ]) assert.equal(sameLine({ runtime, previous_version: before, version: after }), expected);
  const bot = 'runtime-bot[bot]', A = 'a'.repeat(40), B = 'b'.repeat(40);
  const pr = { state: 'open', draft: false, user: { login: bot }, labels: [],
    base: { ref: 'main', repo: { full_name: 'videoq-jp/videoq' } },
    head: { ref: 'runtime/node-current', sha: A, repo: { full_name: 'videoq-jp/videoq' } } };
  const receipt = { user: { login: bot }, body: '<!-- videoq-runtime-update-v1 -->\n' + JSON.stringify({ ...plan(), sha: A, base: B }) };
  const files = [{ filename: '.node-version', status: 'modified' }];
  assert.equal(eligible(pr, files, [receipt], bot), true);
  assert.equal(eligible(pr, files, [{ ...receipt, user: { login: 'human' } }], bot), false);
  assert.equal(eligible({ ...pr, head: { ...pr.head, sha: B } }, files, [receipt], bot), false);
  assert.equal(eligible({ ...pr, labels: [{ name: 'no-automerge' }] }, files, [receipt], bot), false);
  assert.equal(eligible(pr, [...files, { filename: '.github/workflows/cd.yml', status: 'modified' }], [receipt], bot), false);
  assert.equal(eligible({ ...pr, head: { ...pr.head, ref: 'runtime/node-next' } }, files, [receipt], bot), false);
});
test('discovery supports schedule and explicit selection; main refresh belongs to the controller', async () => {
  assert.equal((await scope({ context })).matrix.include.length, 10);
  assert.deepEqual((await scope({ context: { ...context, eventName: 'workflow_dispatch' }, runtime: 'uv' })).matrix.include, [{ runtime: 'uv', channel: 'current' }]);
  for (const eventName of ['push', 'workflow_run']) await assert.rejects(scope({ context: { ...context, eventName } }), /Unsupported/);
});

test('unchanged proposals are left for the controller; superseded proposals retire and opt-outs are preserved', async () => {
  function managedFixture() {
    const f = publicationFixture(), old = 'c'.repeat(40), bot = 'runtime-bot[bot]';
    f.pr = { number: 123, node_id: 'PR_123', user: { login: bot }, head: { sha: old }, base: { ref: 'main' }, labels: [], auto_merge: null };
    f.github.rest.pulls.get = async () => ({ data: f.pr });
    f.github.rest.git.getRef = async ({ ref }) => ({ data: { object: { sha: ref === 'heads/main' ? context.sha : old } } });
    f.github.rest.pulls.list = async () => ({ data: [f.pr] });
    f.github.rest.pulls.listCommits = async () => [{ author: { login: bot } }];
    f.github.rest.issues.listComments = async () => [{ user: { login: bot }, body: '<!-- videoq-runtime-update-v1 -->\n' + JSON.stringify({ ...plan(), sha: old }) }];
    f.github.paginate = (fn, args) => fn(args);
    f.github.rest.repos = { compareCommits: async () => ({ data: { ahead_by: 0 } }),
      getContent: async () => ({ data: { content: Buffer.from('26.12.1\n').toString('base64') } }) };
    f.github.rest.pulls.update = async a => { f.writes.push(['update', a]); return { data: f.pr }; };
    f.github.graphql = async () => f.writes.push(['disable']);
    f.args = { github: f.github, context, core: { info() {} }, plan: plan(), bot, retireSuperseded: true };
    return f;
  }
  const same = managedFixture();
  await publish(same.args);
  assert.deepEqual(same.writes, []);
  const refreshed = managedFixture();
  refreshed.github.rest.repos.compareCommits = async () => ({ data: { ahead_by: 1 } });
  refreshed.github.rest.git.updateRef = async args => refreshed.writes.push(['update-ref', args]);
  await publish(refreshed.args);
  assert.equal(refreshed.writes.find(([kind]) => kind === 'update')[1].base, 'main');
  const applied = managedFixture();
  await publish({ ...applied.args, plan: { ...plan(), changed: false, files: {} } });
  assert.equal(applied.writes.find(([kind]) => kind === 'update')[1].state, 'closed');
  const newer = managedFixture();
  await publish({ ...newer.args, plan: { ...plan(), version: '26.12.0', previous_version: '26.12.0', changed: false, files: {} } });
  assert.deepEqual(newer.writes, []);
  const opted = managedFixture(); opted.pr.labels.push({ name: 'no-runtime-update' }); opted.pr.auto_merge = {};
  await publish(opted.args);
  assert.deepEqual(opted.writes, []);
  const modified = managedFixture(); modified.github.rest.issues.listComments = async () => [];
  await assert.rejects(publish(modified.args), /no trusted publication receipt/);
  assert.deepEqual(modified.writes, []);
  const recovered = managedFixture();
  const originalComments = recovered.github.rest.issues.listComments;
  recovered.github.rest.issues.listComments = async () => [...await originalComments(), {
    user: { login: 'runtime-bot[bot]' }, body: '<!-- videoq-runtime-update-v1 -->\n' + JSON.stringify({ kind: 'superseded', sha: 'c'.repeat(40), runtime: 'node', channel: 'current' }),
  }];
  recovered.github.rest.pulls.list = async ({ state }) => ({ data: state === 'open' ? [] : [recovered.pr] });
  recovered.github.rest.git.updateRef = async a => recovered.writes.push(['update-ref', a]);
  recovered.github.rest.pulls.create = async a => { recovered.writes.push(['pr', a]); return { data: { number: 124 } }; };
  await publish({ ...recovered.args, plan: { ...plan(), previous_version: '26.12.1', version: '26.12.2', files: { '.node-version': '26.12.2\n' } } });
  assert.equal(recovered.writes.find(([kind]) => kind === 'update-ref')[1].force, false);
  assert.ok(recovered.writes.some(([kind]) => kind === 'receipt'));
  const manuallyClosed = managedFixture();
  manuallyClosed.github.rest.pulls.list = async ({ state }) => ({ data: state === 'open' ? [] : [manuallyClosed.pr] });
  assert.equal(await publish(manuallyClosed.args), 123);
  assert.deepEqual(manuallyClosed.writes, []);
  for (const mutate of [f => { f.pr.user.login = 'human'; }, f => { f.pr.head.sha = 'd'.repeat(40); }]) {
    const unknown = managedFixture();
    unknown.github.rest.pulls.list = async ({ state }) => ({ data: state === 'open' ? [] : [unknown.pr] });
    mutate(unknown);
    await assert.rejects(publish(unknown.args), /unmanaged runtime branch/);
    assert.deepEqual(unknown.writes, []);
  }
});
