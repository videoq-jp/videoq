import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { skillInstallerRoutes } from '../src/features/skills/installer-routes';
import { installerSource } from '../src/features/skills/installer-source';
import { skillFixtureId } from './fixtures/agent-skill';
import type { Bindings } from '../src/types/bindings';

const execute = promisify(execFile);
afterEach(() => vi.unstubAllGlobals());
it('serves the bundled installer without a frontend subrequest and binds it to the configured service', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('Frontend unavailable'));
  vi.stubGlobal('fetch', fetcher);
  const env = { FRONTEND_URL: 'https://videoq.example' } as Bindings;
  const response = await skillInstallerRoutes.request(`https://untrusted.example/${skillFixtureId}.tgz`, {}, env);
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/gzip');
  const tar = await new Response(response.body!.pipeThrough(new DecompressionStream('gzip'))).text();
  expect(tar).toContain(installerSource);
  expect(tar).toContain('https://videoq.example');
  expect(tar).not.toContain('https://untrusted.example');
  expect(fetcher).not.toHaveBeenCalled();
  expect((await skillInstallerRoutes.request('/invalid.tgz', {}, env)).status).toBe(404);
  expect(installerSource).toBe(await readFile(new URL('../../web/public/skills/install.mjs', import.meta.url), 'utf8'));
});

it('runs the short npx URL command and installs an authenticated multi-skill set without touching project dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'videoq-npx-test-'));
  const skills = ['videoq-client-fixture', 'videoq-sql-fixture'].map(name => ({ id: skillFixtureId, name, files: { 'SKILL.md': `---\nname: ${name}\ndescription: Use this source-derived fixture.\n---\nFollow the source policy.`, 'references/sources.md': '# Source evidence' } }));
  let origin = '';
  const server = createServer((request, response) => {
    void (async () => {
    if (request.url?.endsWith('.tgz')) {
      const artifact = await skillInstallerRoutes.request(`${origin}/${skillFixtureId}.tgz`, {}, { FRONTEND_URL: origin });
      if (!artifact.ok) throw new Error('Installer endpoint failed');
      const bytes = new Uint8Array(await artifact.arrayBuffer());
      response.writeHead(200, { 'content-type': 'application/gzip' }).end(bytes); return;
    }
    if (request.url !== '/api/mcp' || request.headers.authorization !== 'Bearer fixture-key') { response.writeHead(401).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { structuredContent: { skill: { ...skills[0], skills } } };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    })().catch(error => { response.writeHead(500).end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port.');
  origin = `http://127.0.0.1:${address.port}`;
  try {
    await writeFile(join(directory, 'package.json'), '{"name":"fixture-project","private":true}');
    const result = await execute('npx', ['--yes', '--allow-remote=all', `${origin}/api/skills/${skillFixtureId}.tgz`, '--agent', 'codex'], { cwd: directory,
      env: { ...process.env, VIDEOQ_API_KEY: 'fixture-key', npm_config_cache: join(directory, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }, timeout: 30_000 });
    expect(result.stdout).toContain('Installed published skills (2)'); expect(result.stdout).not.toContain('fixture-key');
    for (const skill of skills) expect(await readFile(join(directory, '.agents/skills', skill.name, 'SKILL.md'), 'utf8')).toBe(skill.files['SKILL.md']);
    expect(await readFile(join(directory, 'package.json'), 'utf8')).toBe('{"name":"fixture-project","private":true}');
    await expect(readFile(join(directory, 'package-lock.json'))).rejects.toThrow();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}, 40_000);
