const { test } = require('node:test');
const assert = require('node:assert/strict');
const check = require('./cloudflare-token-expiry.cjs');
const realConfig = require('../cloudflare-token-expiry.json');
const BOT = 'github-actions[bot]';

function fixture(date = '2026-11-17') {
  const config = structuredClone(realConfig);
  // Keep tests deterministic after the production expiry is renewed.
  for (const entry of config.credentials) entry.expiresOn = '2026-12-17';
  const issues = [], comments = [], mutations = [], failures = [], summaries = [];
  const api = {
    listForRepo: async () => [...issues],
    listComments: async ({ issue_number }) => comments.filter(c => c.issue_number === issue_number),
    create: async args => {
      const issue = { ...args, number: issues.length + 1, state: 'open', user: { login: BOT }, html_url: 'https://github.com/example/1' };
      issues.push(issue); mutations.push(['create', args]); return { data: issue };
    },
    update: async args => {
      Object.assign(issues.find(i => i.number === args.issue_number), args);
      mutations.push(['update', args]);
    },
    createComment: async args => { comments.push({ ...args, user: { login: BOT } }); mutations.push(['comment', args]); },
  };
  const github = { rest: { issues: api }, paginate: async (method, args) => method(args) };
  const context = { repo: { owner: 'videoq-jp', repo: 'videoq' }, ref: 'refs/heads/main', eventName: 'schedule' };
  const core = {
    warning() {}, setFailed: value => failures.push(value),
    summary: { addRaw(value) { summaries.push(value); return this; }, async write() {} },
  };
  return { github, context, core, config, now: new Date(`${date}T23:59:59Z`), issues, comments, mutations, failures, summaries };
}

test('the real metadata is valid without reading credentials', () => check.validateConfig(realConfig));

for (const [days, stage] of [[31, null], [30, '30-days'], [29, '30-days'], [15, '30-days'], [14, '14-days'], [8, '14-days'], [7, '7-days'], [2, '7-days'], [1, '1-day'], [0, 'expired'], [-1, 'expired']]) {
  test(`expiry stage catches up at ${days} days`, () => assert.equal(check.stageFor(days), stage));
}

test('healthy check has no writes or failure', async () => {
  const f = fixture('2026-11-16');
  await check(f);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.failures.length, 0);
  assert.match(f.summaries[0], /31 days remaining/);
});

test('expiry stages retain summaries and urgent failures without accessing Issues', async () => {
  const f = fixture();
  f.github = new Proxy({}, { get() { throw new Error('GitHub API must not be used'); } });
  for (const day of ['2026-11-17', '2026-12-04', '2026-12-11', '2026-12-16', '2026-12-18']) {
    f.now = new Date(`${day}T09:00:00Z`);
    await check(f);
  }
  assert.equal(f.failures.length, 3);
  for (const entry of f.config.credentials) assert.ok(f.summaries[0].includes(entry.name));
  assert.match(f.failures[0], /workflow summary/);
});

test('dry-run can simulate expiry but never writes or fails as an expiry alert', async () => {
  const f = fixture(); f.dryRun = true; f.previewDate = '2026-12-18';
  const result = await check(f);
  assert.equal(result.urgent, true);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.failures.length, 0);
  assert.match(f.summaries[0], /dry run/);
});

test('date overrides cannot generate real false-positive alerts', async () => {
  const f = fixture(); f.previewDate = '2026-12-18';
  await assert.rejects(check(f), /requires dry_run/);
  assert.equal(f.mutations.length, 0);
});

for (const [name, change] of [
  ['invalid date', f => { f.config.credentials[0].expiresOn = '2026-02-30'; }],
  ['missing expiry', f => { delete f.config.credentials[0].expiresOn; }],
  ['empty tracking', f => { f.config.credentials = []; }],
  ['duplicate ID', f => { f.config.credentials.push(f.config.credentials[0]); }],
  ['untrusted assignee text', f => { f.config.assignee = 'someone @everyone'; }],
  ['fork', f => { f.context.repo.owner = 'fork'; }],
  ['feature branch', f => { f.context.ref = 'refs/heads/feature'; }],
  ['tag named main', f => { f.context.ref = 'refs/tags/main'; }],
  ['PR event', f => { f.context.eventName = 'pull_request'; }],
]) {
  test(`rejects ${name} before writing any notification`, async () => {
    const f = fixture(); change(f);
    await assert.rejects(check(f));
    assert.equal(f.mutations.length, 0);
  });
}

test('SSM token destinations are metadata only and restricted to the production security prefix', () => {
  const f = fixture();
  f.config.credentials[0].secrets = ['ssm:/videoq/security/prod/background-maintenance'];
  assert.doesNotThrow(() => check.validateConfig(f.config));
  for (const value of ['ssm:/other/account/secret', 'ssm:/videoq/security/prod/../secret', 'ssm:/videoq/security/prod/key\nPRIVATE']) {
    f.config.credentials[0].secrets = [value];
    assert.throws(() => check.validateConfig(f.config));
  }
});
