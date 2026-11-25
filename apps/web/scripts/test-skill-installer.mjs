import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { options, connect, rpcResponse, downloadSkill, install } from '../public/skills/install.mjs';

const skillId = '3dc4072c-d22f-42f6-81e5-96f6686916ab';
const config = { origin: 'https://videoq.example', skill: skillId, agent: 'both', global: false };
const skill = { id: skillId, name: 'videoq-rate-limited-client-3dc4072c', files: {
  'SKILL.md': '---\nname: videoq-rate-limited-client-3dc4072c\ndescription: Implement the lab API client retry policy.\n---\n\nOn HTTP 429 return deferred. Never sleep in the helper. See [evidence](references/sources.md).\n',
  'references/sources.md': '# Source evidence\n\nClient retry policy 00:00:10,000\n> Never sleep or retry in the helper.\n',
} };
const bundle = { name: skill.name, files: new Map(Object.entries(skill.files)) };
async function workspace(run) { const cwd = await mkdtemp(join(tmpdir(), 'videoq-skill-test-')); try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); } }

test('requires a published skill ID and rejects insecure origins and legacy transcript export', () => {
  assert.equal(options(['--origin', config.origin, '--skill', skillId, '--global']).global, true);
  for (const args of [[], ['--origin', 'http://remote.example', '--skill', skillId], ['--origin', config.origin, '--skill', '../2'], ['--origin', config.origin, '--course', '7'], ['--origin', config.origin, '--skill', skillId, '--agent', 'invalid']]) assert.throws(() => options(args));
  assert.equal(options(['--origin', 'http://localhost:8000', '--skill', skillId]).skill, skillId);
});

test('downloads the published artifact without deriving instructions or calling a model', async () => {
  const requests = [];
  const downloaded = await downloadSkill({ async call(name, args) { requests.push({ name, args }); return { skill }; } }, config);
  assert.deepEqual(requests, [{ name: 'get_skill', args: { skill_id: skillId, offset: 0, limit: 1 } }]);
  assert.deepEqual(Object.fromEntries(downloaded.files), skill.files);
});

test('refuses path traversal, scripts, mismatched identities and unpublished tool errors', async () => {
  for (const value of [{ ...skill, name: '../outside' }, { ...skill, id: 'another-id' }, { ...skill, files: { ...skill.files, 'scripts/run.sh': 'evil' } }, { ...skill, files: { ...skill.files, 'SKILL.md': '# Wrong name' } }]) {
    await assert.rejects(downloadSkill({ async call() { return { skill: value }; } }, config), /Invalid|identity/);
  }
  await assert.rejects(downloadSkill({ async call() { throw new Error('Review and publish first.'); } }, config), /publish/);
});

test('installs identical generated instructions and evidence into both discovery locations', async () => workspace(async cwd => {
  const paths = await install(bundle, config, { cwd });
  assert.equal(paths.length, 2);
  for (const path of paths) {
    assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), skill.files['SKILL.md']);
    assert.equal(await readFile(join(path, 'references/sources.md'), 'utf8'), skill.files['references/sources.md']);
  }
  await assert.rejects(install(bundle, config, { cwd }), /Already installed/);
  assert.equal(await readFile(join(paths[0], 'SKILL.md'), 'utf8'), skill.files['SKILL.md']);
}));

test('global scope installs for the selected agent only', async () => workspace(async cwd => {
  const paths = await install(bundle, { ...config, agent: 'codex', global: true }, { cwd: join(cwd, 'project'), home: cwd });
  assert.equal(paths[0], join(cwd, '.agents/skills', bundle.name));
  assert.equal(paths.length, 1);
}));

test('refuses symlinks and leaves both targets unchanged when the second already exists', async () => workspace(async cwd => {
  await mkdir(join(cwd, '.claude/skills'), { recursive: true });
  await symlink(cwd, join(cwd, '.claude/skills', bundle.name));
  await assert.rejects(install(bundle, config, { cwd }), /Already installed/);
  assert.deepEqual(await readdir(join(cwd, '.agents/skills')), []);
}));

test('validates and installs a course skill set in one operation, with all-or-nothing conflict handling', async () => workspace(async cwd => {
  const secondName = 'videoq-sql-plan-3dc4072c';
  const second = { ...skill, name: secondName, files: { ...skill.files, 'SKILL.md': skill.files['SKILL.md'].replaceAll(skill.name, secondName) } };
  const set = { ...skill, skills: [skill, second] };
  const downloaded = await downloadSkill({ async call() { return { skill: set }; } }, config);
  assert.equal(downloaded.skills.length, 2);
  const paths = await install(downloaded, config, { cwd });
  assert.equal(paths.length, 4);
  for (const agent of ['.agents', '.claude']) for (const member of set.skills) {
    assert.equal(await readFile(join(cwd, agent, 'skills', member.name, 'SKILL.md'), 'utf8'), member.files['SKILL.md']);
  }
  for (const invalid of [{ ...set, skills: [skill, skill] }, { ...set, skills: [skill, { ...second, name: '../escape' }] }, { ...set, skills: [] }]) {
    await assert.rejects(downloadSkill({ async call() { return { skill: invalid }; } }, config), /Invalid/);
  }
  await rm(join(cwd, '.agents/skills', skill.name), { recursive: true });
  await rm(join(cwd, '.claude/skills', skill.name), { recursive: true });
  await assert.rejects(install(downloaded, config, { cwd }), /Already installed/);
  // A conflict in a later member must not leave an earlier member installed.
  assert.ok(!(await readdir(join(cwd, '.agents/skills'))).includes(skill.name));
  assert.ok(!(await readdir(join(cwd, '.claude/skills'))).includes(skill.name));
}));

test('parses JSON and split CRLF SSE, cancelling persistent streams after the response', async () => {
  assert.deepEqual(await rpcResponse(Response.json({ id: 1, result: { ok: true } }), 1), { ok: true });
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"method":"notifications/progress"}\r'));
    controller.enqueue(new TextEncoder().encode('\n\r\ndata: {"id":2,"result":{"ok":true}}\r\n\r\n'));
  }, cancel() { cancelled = true; } });
  assert.deepEqual(await rpcResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), 2), { ok: true });
  assert.equal(cancelled, true);
  await assert.rejects(rpcResponse(new Response('', { status: 401 }), 1), /401/);
});

test('negotiates MCP and authenticates every request without following redirects', async () => {
  const calls = [];
  const client = await connect(config.origin, 'vq_secret', async (_url, init) => {
    calls.push(init);
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ id: rpc.id, result: rpc.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { structuredContent: { skill } } }, { headers: { 'mcp-session-id': 'test-session' } });
  });
  assert.deepEqual(await client.call('get_skill', { skill_id: skillId }), { skill }); await client.close();
  assert.ok(calls.every(c => c.headers.Authorization === 'Bearer vq_secret' && c.redirect === 'error'));
  assert.equal(calls[2].headers['Mcp-Session-Id'], 'test-session');
});

test('real CLI downloads and installs a published skill set through the read-only MCP tool', async () => workspace(async cwd => {
  const second = { ...skill, name: 'videoq-sql-plan-3dc4072c', files: { ...skill.files, 'SKILL.md': skill.files['SKILL.md'].replaceAll(skill.name, 'videoq-sql-plan-3dc4072c') } };
  const set = { ...skill, skills: [skill, second] };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer vq_fixture');
    let body = ''; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    if (rpc.method === 'tools/call') { assert.equal(rpc.params.name, 'get_skill'); assert.deepEqual(rpc.params.arguments, { skill_id: skillId, offset: 0, limit: 1 }); }
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { structuredContent: { skill: set } };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  try {
    const script = join(cwd, 'install.mjs'); await writeFile(script, await readFile(new URL('../public/skills/install.mjs', import.meta.url)));
    const child = spawn(process.execPath, [script, '--origin', `http://127.0.0.1:${server.address().port}`, '--skill', skillId], { cwd, env: { ...process.env, VIDEOQ_API_KEY: 'vq_fixture' } });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(accept => child.on('close', accept));
    assert.equal(code, 0, output); assert.match(output, /Installed published skill/); assert.doesNotMatch(output, /vq_fixture/);
    assert.equal(await readFile(join(cwd, '.claude/skills', skill.name, 'SKILL.md'), 'utf8'), skill.files['SKILL.md']);
    assert.equal(await readFile(join(cwd, '.agents/skills', skill.name, 'SKILL.md'), 'utf8'), skill.files['SKILL.md']);
    for (const agent of ['.agents', '.claude']) assert.equal(await readFile(join(cwd, agent, 'skills', second.name, 'SKILL.md'), 'utf8'), second.files['SKILL.md']);
  } finally { await new Promise(accept => server.close(accept)); }
}));

test('downloads more than 12 skills and over 2 MB of evidence in complete pages', async () => {
  const artifacts = Array.from({ length: 17 }, (_, index) => {
    const name = `videoq-page-${index}`;
    return { ...skill, name, files: { ...skill.files, 'SKILL.md': skill.files['SKILL.md'].replaceAll(skill.name, name), 'references/sources.md': '証拠'.repeat(80_000) } };
  });
  const offsets = [];
  const downloaded = await downloadSkill({ async call(_name, args) {
    offsets.push(args.offset);
    const artifact = artifacts[args.offset];
    return { skill: { ...artifact, skills: [artifact], totalSkills: artifacts.length, nextOffset: args.offset + 1 < artifacts.length ? args.offset + 1 : null } };
  } }, config);
  assert.equal(downloaded.skills.length, 17);
  assert.deepEqual(offsets, Array.from({ length: 17 }, (_, index) => index));
  assert.ok(downloaded.skills.reduce((bytes, item) => bytes + Buffer.byteLength(item.files.get('references/sources.md')), 0) > 2_000_000);
});

test('refuses missing pages, repeated identities and inconsistent pagination totals', async () => {
  for (const value of [
    { ...skill, skills: [skill], totalSkills: 2, nextOffset: null },
    { ...skill, skills: [skill], totalSkills: 2, nextOffset: 0 },
    { ...skill, skills: [skill], totalSkills: 2, nextOffset: 3 },
  ]) await assert.rejects(downloadSkill({ async call() { return { skill: value }; } }, config), /Incomplete|Invalid/);
  await assert.rejects(downloadSkill({ async call() { return { skill: { ...skill, skills: [skill], totalSkills: 2, nextOffset: 1 } }; } }, config), /Invalid/);
});
