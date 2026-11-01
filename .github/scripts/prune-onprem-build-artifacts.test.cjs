const { test } = require('node:test');
const assert = require('node:assert/strict');
const prune = require('./prune-onprem-build-artifacts.cjs');
const sha = 'a'.repeat(40);
function fixture() {
  const deleted = [];
  const context = { repo: { owner: 'videoq-jp', repo: 'videoq' }, ref: 'refs/heads/main', eventName: 'workflow_dispatch', sha, runId: 123, runAttempt: 2 };
  const run = { id: 123, path: '.github/workflows/onprem-release.yml', head_sha: sha, head_branch: 'main', head_repository: { full_name: 'videoq-jp/videoq' }, run_attempt: 2 };
  const artifact = (id, name) => ({ id, name, size_in_bytes: 100, expired: false, workflow_run: { id: 123, head_sha: sha } });
  const artifacts = [artifact(1, `build-web-amd64-${sha}-attempt-2`), artifact(2, `build-api-arm64-${sha}-attempt-2`),
    artifact(3, `security-api-amd64-${sha}-attempt-2`), artifact(4, `onprem-release-${sha}-attempt-2`),
    artifact(5, `build-api-amd64-${sha}-attempt-1`), artifact(6, `build-api-amd64-${'b'.repeat(40)}-attempt-2`), artifact(7, `build-vllm-engine-amd64-${sha}-attempt-2`)];
  const github = { rest: { actions: {
    getWorkflowRun: async () => ({ data: run }), listWorkflowRunArtifacts() {},
    deleteArtifact: async ({ artifact_id }) => deleted.push(artifact_id),
  } }, paginate: async (_method, options) => { assert.equal(options.run_id, 123); return artifacts; } };
  return { context, run, artifacts, github, deleted, sourceSha: sha };
}
test('deletes only this run/attempt build archives, retaining signed evidence and other attempts', async () => {
  const f = fixture(); assert.deepEqual(await prune(f), { deleted: 2, bytes: 200 }); assert.deepEqual(f.deleted, [1, 2]);
});
for (const [name, change] of [
  ['foreign repository', f => { f.context.repo.owner = 'someone'; }],
  ['pull request', f => { f.context.eventName = 'pull_request'; }],
  ['non-main ref', f => { f.context.ref = 'refs/heads/feature'; }],
  ['wrong workflow', f => { f.run.path = '.github/workflows/ci.yml'; }],
  ['fork', f => { f.run.head_repository.full_name = 'someone/videoq'; }],
  ['different run attempt', f => { f.run.run_attempt = 3; }],
  ['wrong source', f => { f.run.head_sha = 'b'.repeat(40); }],
  ['foreign artifact inside a batch', f => { f.artifacts[1].workflow_run.id = 999; }],
]) test(`fails before deleting any artifact: ${name}`, async () => {
  const f = fixture(); change(f); await assert.rejects(prune(f)); assert.deepEqual(f.deleted, []);
});

test('the real workflow waits for publication and passes GitHub Context prototype getters correctly', async () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const workflow = readFileSync(join(__dirname, '../workflows/onprem-release.yml'), 'utf8');
  const job = workflow.match(/^  cleanup-build-archives:\n([\s\S]*?)(?=^  indexes:)/m)[1];
  assert.match(job, /needs: \[source, publish\]/);
  assert.match(job, /if: needs.publish.result == 'success'/);
  assert.doesNotMatch(job, /secrets\.|packages: write|id-token: write/);
  const script = job.match(/          script: \|\n([\s\S]*)/)[1].split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
  const f = fixture();
  const { repo: _repo, ...properties } = f.context;
  const context = Object.assign(Object.create({ get repo() { return { owner: 'videoq-jp', repo: 'videoq' }; } }), properties);
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  await new AsyncFunction('require', 'github', 'context', 'core', 'process', script)(
    () => prune, f.github, context, { info() {} }, { env: { SOURCE_SHA: sha, GITHUB_RUN_ATTEMPT: '2' } },
  );
  assert.deepEqual(f.deleted, [1, 2]);
});


test('pruning covers the actual eight-image matrix without deleting a legacy GPU archive', async () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const workflow = readFileSync(join(__dirname, '../workflows/onprem-release.yml'), 'utf8');
  const build = workflow.match(/^  build:\n([\s\S]*?)(?=^  chart:)/m)[1];
  const components = build.match(/component: \[([^\]]+)\]/)[1].split(',').map(x => x.trim());
  const architectures = build.match(/arch: \[([^\]]+)\]/)[1].split(',').map(x => x.trim());
  const f = fixture();
  const model = f.artifacts[0];
  const names = components.flatMap(component => architectures.map(arch => `build-${component}-${arch}-${sha}-attempt-2`));
  f.artifacts.splice(0, f.artifacts.length, ...names.map((name, i) => ({ ...model, id: i+1, name })));
  f.artifacts.push({ ...model, id: 99, name: `build-vllm-engine-amd64-${sha}-attempt-2` });
  const result = await prune(f);
  assert.equal(result.deleted, 8);
  assert.deepEqual(f.deleted, [1, 2, 3, 4, 5, 6, 7, 8]);
});
