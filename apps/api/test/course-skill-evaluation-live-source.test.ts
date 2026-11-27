import { expect, test, vi } from 'vitest';
import { readLiveSourcePin } from '../scripts/course-skill-evaluation/live-source';
import type { FrozenCourse } from '../scripts/course-skill-evaluation/environment';

const source: FrozenCourse = { courseId: 51,
  videos: [{ id: 1, title: 'Synthetic lecture', transcript: 'private synthetic input', user_id: 'owner', status: 'completed', revision: 'rev' }],
  runs: [{ id: 'run', video_id: 1, user_id: 'owner', source_revision: 'rev', dimensions: 768, embedding_identity: 'identity', embedding_fingerprint: 'fingerprint', expected_scenes: 0, status: 'published' }], scenes: [] };
const row = { video_id: 1, title: 'Synthetic lecture', user_id: 'owner', status: 'completed', revision: 'rev', membership_id: 1, run_id: 'run', source_revision: 'rev', dimensions: 768, embedding_identity: 'identity', embedding_fingerprint: 'fingerprint', expected_scenes: 0, run_status: 'published' };
function options(rows: unknown[]) {
  const request = vi.fn<typeof fetch>(async () => Response.json({ success: true, result: [{ success: true, results: rows }] }));
  return { source, accountId: 'a'.repeat(32), databaseId: '11111111-1111-1111-1111-111111111111', token: async () => 'synthetic-token', fetch: request };
}
test('uses a fixed parameterized SELECT and pins membership identity', async () => {
  const first = options([row]);
  const pin = await readLiveSourcePin(first);
  expect(pin).toMatch(/^[a-f0-9]{64}$/);
  const [url, request] = first.fetch.mock.calls[0];
  expect(url).toEqual(expect.stringContaining('/d1/database/'));
  if (typeof request?.body !== 'string') throw new Error('Expected JSON request body');
  const body = JSON.parse(request.body);
  expect(body.sql.trim()).toMatch(/^SELECT /);
  expect(body.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
  expect(body.params).toEqual([51, 1]);
  expect(await readLiveSourcePin(options([{ ...row, membership_id: 2 }]))).not.toBe(pin);
});
test.each([
  { revision: 'new' }, { run_id: 'new' }, { embedding_fingerprint: 'new' },
  { user_id: 'other' }, { run_status: 'staging' }, { status: 'processing' },
])('rejects changed live inputs %j', async change => {
  await expect(readLiveSourcePin(options([{ ...row, ...change }]))).rejects.toThrow('LIVE_SOURCE_CHANGED');
});
test('rejects missing membership and expired authentication', async () => {
  await expect(readLiveSourcePin(options([]))).rejects.toThrow('LIVE_SOURCE_UNAVAILABLE');
  const expired = options([row]); expired.fetch.mockResolvedValue(new Response(null, { status: 401 }));
  await expect(readLiveSourcePin(expired)).rejects.toThrow('LIVE_SOURCE_HTTP_401');
});
