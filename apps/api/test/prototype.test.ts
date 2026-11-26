import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrototypeApp } from '../src/runtime/prototype-app';
import { createJsonScenarioSource } from '../src/integrations/prototype/scenario-source';

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(mode: 'memory' | 'stub' = 'memory') {
  const directory = await mkdtemp(join(tmpdir(), 'videoq-prototype-')); temporary.push(directory);
  const path = join(directory, 'scenario.json');
  const document = JSON.parse(await readFile(fileURLToPath(new URL('../prototype/default.json', import.meta.url).href), 'utf8'));
  await writeFile(path, JSON.stringify(document));
  const app = createPrototypeApp({ scenario: path, mode, now: () => new Date('2026-11-27T00:00:00Z') });
  const save = () => writeFile(path, JSON.stringify(document));
  return { app, path, document, save };
}
async function rpc(app: ReturnType<typeof createPrototypeApp>, name: string, input: unknown, mutation = false) {
  const response = await app.request(`/api/trpc/${name}${mutation ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
    mutation ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : undefined);
  const body = await response.json<{ result?: { data: unknown }; error?: { message: string; data: { code: string; applicationCode?: string } } }>();
  return { status: response.status, data: body.result?.data, error: body.error };
}

it('runs the unchanged router and real course workflow with no DB or external API', async () => {
  const remote = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests are forbidden'));
  const { app } = await fixture();
  expect(await rpc(app, 'courses.create', { name: 'Learn', description: 'Original workflow' }, true)).toMatchObject({ status: 200, data: { id: 1, name: 'Learn' } });
  expect(await rpc(app, 'courses.get', { id: 1 })).toMatchObject({ status: 200, data: { name: 'Learn', access_role: 'owner' } });
  expect(await rpc(app, 'courses.createShare', { id: 1, shareSlug: 'my-course' }, true)).toMatchObject({ status: 200, data: { share_slug: 'my-course' } });
  expect(await rpc(app, 'courses.shared', { slug: 'my-course' })).toMatchObject({ status: 200, data: { access_role: 'public' } });
  expect(await rpc(app, 'courses.update', { id: 1, name: 'Changed' }, true)).toMatchObject({ status: 200, data: { name: 'Changed' } });
  expect(await rpc(app, 'courses.list', {})).toMatchObject({ status: 200, data: { meta: { total: 1, limit: 24 } } });
  expect(await rpc(app, 'courses.delete', { id: 1 }, true)).toMatchObject({ status: 200, data: { success: true } });
  expect(await rpc(app, 'courses.get', { id: 1 })).toMatchObject({ status: 404 });
  expect(remote).not.toHaveBeenCalled();
});
it('keeps auth, administrator checks, validation and instance isolation at the router boundary', async () => {
  const f = await fixture();
  await rpc(f.app, 'courses.create', { name: 'Private' }, true);
  f.document.session.userId = 'other'; await f.save();
  expect(await rpc(f.app, 'courses.get', { id: 1 })).toMatchObject({ status: 404 });
  expect(await rpc(f.app, 'courses.create', { name: '' }, true)).toMatchObject({ status: 400 });
  expect(await rpc(f.app, 'admin.listUsers', {})).toMatchObject({ status: 403 });
  f.document.session.userId = null; await f.save();
  expect(await rpc(f.app, 'courses.list', {})).toMatchObject({ status: 401 });
  const independent = createPrototypeApp({ scenario: f.path, mode: 'memory' });
  f.document.session.userId = 'prototype-user'; await f.save();
  expect(await rpc(independent, 'courses.get', { id: 1 })).toMatchObject({ status: 404 });
});
it('replays JSON success/error sequences and hot reloads without restarting', async () => {
  const f = await fixture('stub');
  f.document.repeatLast = false;
  f.document.procedures['courses.get'] = [
    { output: { id: 7, name: 'First', description: '', display_order: 0, created_at: '', video_count: 0 } },
    { failure: { kind: 'conflict', code: 'EDIT_CONFLICT', message: 'Please retry' } },
  ];
  await f.save();
  expect(await rpc(f.app, 'courses.get', { id: 7 })).toMatchObject({ status: 200, data: { name: 'First' } });
  expect(await rpc(f.app, 'courses.get', { id: 7 })).toMatchObject({ status: 409, error: { data: { applicationCode: 'EDIT_CONFLICT' } } });
  expect(await rpc(f.app, 'courses.get', { id: 7 })).toMatchObject({ status: 409 });
  f.document.procedures['courses.get'][0].output.name = 'Reloaded'; await f.save();
  expect(await rpc(f.app, 'courses.get', { id: 7 })).toMatchObject({ status: 200, data: { name: 'Reloaded' } });
});
it('rejects invalid/unknown outputs and recovers when the JSON is repaired', async () => {
  const f = await fixture('stub');
  const source = createJsonScenarioSource(f.path);
  await source.load();
  f.document.procedures['account.me'] = [{ output: { id: 'incomplete' } }]; await f.save();
  await expect(source.load()).rejects.toMatchObject({ code: 'SCENARIO_INVALID' });
  delete f.document.procedures['account.me']; f.document.procedures.unknown = [{ output: {} }]; await f.save();
  await expect(source.load()).rejects.toMatchObject({ code: 'SCENARIO_INVALID' });
  delete f.document.procedures.unknown; await f.save();
  expect((await source.load()).document.version).toBe(1);
  expect(await rpc(f.app, 'account.me', undefined)).toMatchObject({ status: 500 });
});
it('supports sequential protocol-specific fixtures including SSE and empty responses', async () => {
  const f = await fixture();
  f.document.repeatLast = false;
  f.document.http['POST /api/chat/message'] = [
    { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' },
    { status: 503, body: { error: 'provider_unavailable' } },
  ];
  f.document.http['DELETE /api/prototype'] = [{ status: 204 }]; await f.save();
  const response = await f.app.request('/api/chat/message', { method: 'POST' });
  expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  expect(await response.text()).toContain('event: done');
  expect((await f.app.request('/api/chat/message', { method: 'POST' })).status).toBe(503);
  expect((await f.app.request('/api/chat/message', { method: 'POST' })).status).toBe(409);
  expect((await f.app.request('/api/prototype', { method: 'DELETE' })).status).toBe(204);
});
