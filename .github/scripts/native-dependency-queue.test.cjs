const { test } = require('node:test');
const assert = require('node:assert/strict');
const native = require('./native-dependency-queue.cjs');
const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40), GROUP = 'c'.repeat(40);
const context = { repo: { owner: 'videoq-jp', repo: 'videoq' }, ref: 'refs/heads/main', eventName: 'push', payload: {} };
function fixture() {
  const pr = { number: 1, node_id: 'PR_1', state: 'open', draft: false, user: { login: 'dependabot[bot]' },
    base: { ref: 'main' }, head: { sha: SHA, ref: 'dependabot/npm_and_yarn/test', repo: { full_name: 'videoq-jp/videoq' } }, labels: [] };
  const f = { pr, comments: [], reserved: [], repairs: [], dispatches: [], disabled: [], mutations: [], queued: false, outcome: 'success', proofs: true };
  f.protection = { enforce_admins: { enabled: true }, required_status_checks: { strict: false,
    checks: ['CI Success', 'Supply Chain Security', 'Terraform Plan', 'Container Validation'].map(context => ({ context, app_id: 15368 })) } };
  f.rules = [{ type: 'merge_queue', parameters: { max_entries_to_build: 1, max_entries_to_merge: 1, merge_method: 'MERGE' } }];
  f.run = { id: 50, run_attempt: 1, workflow_id: 10, event: 'merge_group', status: 'completed', conclusion: 'failure',
    head_sha: GROUP, head_branch: 'gh-readonly-queue/main/pr-1-deadbeef', repository: { full_name: 'videoq-jp/videoq' }, head_repository: { full_name: 'videoq-jp/videoq' } };
  const methods = {
    repos: { getBranch: async () => ({ data: { commit: { sha: BASE } } }),
      getBranchProtection: async () => ({ data: f.protection }),
      compareCommits: async ({ base }) => ({ data: base === SHA ? { merge_base_commit: { sha: f.ancestor || SHA } } : { behind_by: 1 } }) },
    pulls: { list: async () => [pr], get: async () => ({ data: pr }) },
    issues: { createComment: async ({ body }) => { f.comments.push({ user: { login: 'github-actions[bot]' }, body }); } },
    actions: { createWorkflowDispatch: async data => f.dispatches.push(data), getWorkflowRun: async () => ({ data: f.run }),
      getWorkflow: async () => ({ data: { id: 10 } }), listWorkflowRuns: async () => ({ data: { workflow_runs: [f.run] } }) },
  };
  f.github = { rest: methods, paginate: (method, args) => method(args) };
  f.writerGithub = { rest: methods, request: async (route, values) => {
    assert.equal(route, 'GET /repos/{owner}/{repo}/rules/branches/{branch}');
    assert.deepEqual(values, { owner: 'videoq-jp', repo: 'videoq', branch: 'main' });
    return { data: f.rules };
  }, graphql: async (query, values) => {
    if (query.startsWith('mutation')) {
      f.mutations.push({ query, values });
      if (query.includes('enqueuePullRequest')) f.reserved.push({ number: Number(values.id.replace('PR_', '')), sha: values.sha });
      else f.disabled.push(values.id);
      return;
    }
    return { repository: { pullRequest: { mergeQueueEntry: f.queued ? { id: 'entry', enqueuer: { __typename: f.enqueuerType || 'Bot', login: f.enqueuer || 'videoq-dependency-bot' } } : null } } };
  } };
  f.verify = async () => f.proofs ? { pr, kind: 'dependabot', comments: f.comments } : null;
  f.args = { github: f.github, writerGithub: f.writerGithub, context, verify: f.verify,
    evidence: async () => ['ci.yml'].map((workflow_id, i) => ({
      workflow_id, admitted: true, run: { id: i + 1, status: 'completed', conclusion: f.outcome },
    })), prepareRepair: async data => f.repairs.push(data) };
  return f;
}
test('successful eligible PR queues its exact head without a main rebase or issue lease', async () => {
  const f = fixture(); await native.reconcile(f.args);
  assert.deepEqual(f.reserved, [{ number: 1, sha: SHA }]); assert.equal(f.comments.length, 0); assert.equal(f.dispatches.length, 0);
});
test('an existing conflict cannot block a later eligible update or trigger a routine rebase', async () => {
  const f = fixture(); f.pr.mergeable = false;
  const later = { ...structuredClone(f.pr), number: 2, node_id: 'PR_2', mergeable: true };
  f.github.rest.pulls.list = async () => [f.pr, later];
  f.github.rest.pulls.get = async ({ pull_number }) => ({ data: pull_number === 1 ? f.pr : later });
  await native.reconcile({ ...f.args, verify: async ({ pr }) => ({ pr, kind: 'dependabot' }) });
  assert.deepEqual(f.reserved, [{ number: 2, sha: SHA }]);
});
test('the real native mutation enqueues with an expected head instead of enabling unattended auto-merge', async () => {
  const f = fixture(); await native.reconcile({ ...f.args });
  assert.equal(f.mutations.length, 1);
  assert.match(f.mutations[0].query, /enqueuePullRequest\(input:\{pullRequestId:\$id,expectedHeadOid:\$sha\}/);
  assert.deepEqual(f.mutations[0].values, { id: 'PR_1', sha: SHA });
});
test('native protection fails closed for missing checks, spoofed apps, missing queue, admin bypass and speculative builds', async () => {
  for (const mutate of [f => f.protection.required_status_checks.checks.pop(), f => f.protection.required_status_checks.checks[0].app_id = 1,
    f => f.rules = [], f => f.protection.enforce_admins.enabled = false, f => f.rules[0].parameters.max_entries_to_build = 2,
    f => f.protection.required_status_checks.strict = true]) {
    const f = fixture(); mutate(f); await assert.rejects(native.reconcile(f.args), /requires protected main/); assert.equal(f.reserved.length, 0);
  }
});
test('queued PRs are left to GitHub and an unverified bot proposal loses auto-merge', async () => {
  const f = fixture(); f.queued = true; await native.reconcile(f.args); assert.equal(f.reserved.length, 0);
  f.proofs = false; f.pr.auto_merge = { enabled_by: { login: 'videoq-dependency-bot[bot]' } }; await native.reconcile(f.args); assert.deepEqual(f.disabled, ['PR_1', 'PR_1']);
  assert.match(f.mutations[0].query, /dequeuePullRequest\(input:\{id:\$id\}/);
  assert.match(f.mutations[1].query, /disablePullRequestAutoMerge/);
});
test('ineligible automatic updates retain a maintainer-owned manual queue entry and auto-merge request', async () => {
  const f = fixture(); f.proofs = false; f.queued = true; f.enqueuer = 'maintainer'; f.enqueuerType = 'User';
  f.pr.auto_merge = { enabled_by: { login: 'maintainer' } };
  await native.reconcile(f.args);
  assert.equal(f.mutations.length, 0); assert.equal(f.reserved.length, 0); assert.equal(f.repairs.length, 0);
});
test('a human account with the App slug is never mistaken for the automatic Bot', async () => {
  const f = fixture(); f.proofs = false; f.queued = true; f.enqueuerType = 'User';
  await native.reconcile(f.args);
  assert.equal(f.mutations.length, 0);
});
test('a normal eligible CI failure uses the existing bounded Claude authorizer', async () => {
  const f = fixture(); f.outcome = 'failure'; await native.reconcile({ ...f.args, repairEnabled: true, authorizeRepair: true });
  assert.equal(f.repairs.length, 1); assert.equal(f.repairs[0].runId, 1); assert.equal(f.reserved.length, 0);
});
test('PR metadata events wake trusted main rather than authorize a model', async () => {
  const f = fixture(); f.outcome = 'failure'; await native.reconcile({ ...f.args, repairEnabled: true });
  assert.equal(f.repairs.length, 0); assert.equal(f.dispatches[0].workflow_id, 'dependency-queue.yml');
});
test('only current-policy repair attempts prevent duplicate dispatch; old scope limits can recover', async () => {
  const f = fixture(); f.outcome = 'failure';
  f.comments.push({ user: { login: 'github-actions[bot]' }, body: '<!-- videoq-claude-dependency-v1 -->\n' + JSON.stringify({ kind: 'attempt', policy: 2, sha: SHA }) });
  await native.reconcile({ ...f.args, repairEnabled: true, authorizeRepair: true });
  assert.equal(f.repairs.length, 0);
  const old = fixture(); old.outcome = 'failure';
  old.comments.push({ user: { login: 'github-actions[bot]' }, body: '<!-- videoq-claude-dependency-v1 -->\n' + JSON.stringify({ kind: 'attempt', sha: SHA }) });
  await native.reconcile({ ...old.args, repairEnabled: true, authorizeRepair: true });
  assert.equal(old.repairs.length, 1);
});
test('a verified conflict authorizes only the affected PR and exact main through the shared worker', async () => {
  const f = fixture(); f.pr.mergeable = false;
  await native.reconcile({ ...f.args, repairEnabled: true, authorizeRepair: true });
  assert.equal(f.reserved.length, 0); assert.equal(f.repairs.length, 1);
  assert.equal(f.repairs[0].mode, 'conflict'); assert.equal(f.repairs[0].number, 1); assert.equal(f.repairs[0].baseSha, BASE);
});
test('unknown mergeability is not treated as approval to enqueue', async () => {
  const f = fixture(); f.pr.mergeable = null;
  await native.reconcile(f.args);
  assert.equal(f.reserved.length, 0); assert.equal(f.repairs.length, 0);
});
test('a mergeability race does not stall later PRs; authentication and other errors still fail closed', async () => {
  const f = fixture(); const later = { ...structuredClone(f.pr), number: 2, node_id: 'PR_2' };
  f.github.rest.pulls.list = async () => [f.pr, later];
  f.github.rest.pulls.get = async ({ pull_number }) => ({ data: pull_number === 1 ? f.pr : later });
  const original = f.writerGithub.graphql;
  f.writerGithub.graphql = async (query, values) => {
    if (query.startsWith('mutation') && values.id === 'PR_1') throw { errors: [{ type: 'UNPROCESSABLE', message: 'Pull request has merge conflicts and Pull request not in mergeable state' }] };
    return original(query, values);
  };
  await native.reconcile({ ...f.args, verify: async ({ pr }) => ({ pr, kind: 'dependabot' }) });
  assert.equal(f.mutations.length, 1); assert.equal(f.mutations[0].values.id, 'PR_2');
  f.writerGithub.graphql = async query => {
    if (query.startsWith('mutation')) throw new Error('Unauthorized');
    return { repository: { pullRequest: { mergeQueueEntry: null } } };
  };
  await assert.rejects(native.reconcile({ ...f.args }), /Unauthorized/);
});
test('historical duplicate notices cannot consume a remaining repair for a different head', async () => {
  const f = fixture(); f.outcome = 'failure';
  for (const data of [{ kind: 'attempt', sha: BASE }, { kind: 'stopped' }]) {
    f.comments.push({ user: { login: 'github-actions[bot]' }, body: '<!-- videoq-claude-dependency-v1 -->\n' + JSON.stringify(data) });
  }
  await native.reconcile({ ...f.args, repairEnabled: true, authorizeRepair: true });
  assert.equal(f.repairs.length, 1);
});
test('group failure needs a genuine workflow, canonical repositories and proof of the current PR head ancestry', async () => {
  for (const mutate of [f => f.run.event = 'pull_request', f => f.run.head_repository.full_name = 'fork/videoq',
    f => f.ancestor = BASE, f => f.run.head_branch = 'feature/pr-1-deadbeef']) {
    const f = fixture(); const ctx = { ...context, eventName: 'workflow_run', payload: { workflow_run: { ...f.run } } }; mutate(f);
    assert.equal(await native.reproduceGroupFailure({ ...f.args, context: ctx, sync: async () => { throw Error('unexpected mutation'); } }), null);
    assert.equal(f.comments.length, 0);
  }
});
test('a proven group failure syncs only that PR once, then normal PR CI owns repair', async () => {
  const f = fixture(); const calls = []; const args = { ...f.args, context: { ...context, eventName: 'workflow_run', payload: { workflow_run: f.run } }, sync: async data => calls.push(data) };
  assert.equal(await native.reproduceGroupFailure(args), 1);
  assert.equal(calls.length, 1); assert.equal(calls[0].expectedSha, SHA);
  assert.equal(await native.reproduceGroupFailure(args), null); assert.equal(calls.length, 1);
});
test('group reproduction is bounded across head changes and a stop blocks automatic queue re-entry', async () => {
  const f = fixture();
  for (const group of ['d'.repeat(40), 'e'.repeat(40)]) f.comments.push({ user: { login: 'github-actions[bot]' },
    body: native.MARKER + '\n' + JSON.stringify({ kind: 'reproduce', sha: BASE, group }) });
  const ctx = { ...context, eventName: 'workflow_run', payload: { workflow_run: f.run } };
  assert.equal(await native.reproduceGroupFailure({ ...f.args, context: ctx, sync: async () => { throw Error('retry limit ignored'); } }), 1);
  assert.equal(native.records(f.comments).at(-1).kind, 'stopped');
  await native.reconcile(f.args); assert.equal(f.reserved.length, 0);
});

test('the controller announces an exhausted CI budget once without waking or dispatching another worker', async () => {
  const f = fixture(); f.outcome = 'failure';
  for (let i = 0; i < 8; i++) f.comments.push({ user: { login: 'github-actions[bot]' },
    body: '<!-- videoq-claude-dependency-v1 -->\n' + JSON.stringify({ kind: 'attempt', policy: 2, mode: 'ci', sha: BASE }) });
  const args = { ...f.args, repairEnabled: true, authorizeRepair: false };
  await native.reconcile(args); await native.reconcile(args);
  assert.equal(f.repairs.length, 0); assert.equal(f.dispatches.length, 0);
  assert.equal(f.comments.filter(c => c.body.includes('"kind":"stopped"')).length, 1);
});

test('runtime CI and conflicts dispatch the same bounded worker while next-line success never queues', async () => {
  for (const channel of ['current', 'next']) {
    const f = fixture();
    f.pr.user.login = 'videoq-dependency-bot[bot]'; f.pr.head.ref = `runtime/python-${channel}`;
    const verify = async () => ({ pr: f.pr, kind: 'runtime', comments: f.comments, autoQueue: channel === 'current' });
    f.outcome = 'failure';
    await native.reconcile({ ...f.args, verify, repairEnabled: true, authorizeRepair: true });
    assert.equal(f.repairs.length, 1);
    f.pr.mergeable = false;
    await native.reconcile({ ...f.args, verify, repairEnabled: true, authorizeRepair: true });
    assert.equal(f.repairs[1].mode, 'conflict');
    f.pr.mergeable = true; f.outcome = 'success';
    await native.reconcile({ ...f.args, verify });
    assert.equal(f.reserved.length, channel === 'current' ? 1 : 0);
  }
});
