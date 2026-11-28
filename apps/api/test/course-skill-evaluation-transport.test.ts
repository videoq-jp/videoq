import { expect, it, vi } from 'vitest';
import { readOnlySearchTransport } from '../scripts/course-skill-evaluation/environment';
import { WORKERS_AI_EMBEDDING_MODEL } from '../src/lib/embedding-contract';

function setup(maxCalls = 4) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result: { count: 0, matches: [] } }));
  const transport = readOnlySearchTransport({ accountId: 'a'.repeat(32), indexName: 'frozen-scenes', ownerId: 'owner', videoIds: [1, 2], maxCalls, token: () => Promise.resolve('synthetic-secret'), fetch: request });
  return { ...transport, request };
}
const vector = Array.from({ length: 768 }, () => 0.1);
const query = { filter: { user_id: 'owner', video_id: { $in: [1] } }, topK: 10, returnMetadata: 'all', returnValues: false };

it('denies every index mutation and unsupported read without an external request', async () => {
  const t = setup();
  for (const operation of [t.index.insert, t.index.upsert, t.index.deleteByIds, t.index.getByIds, t.index.queryById, t.index.describe]) await expect(operation()).rejects.toThrow('EVALUATION_INDEX_OPERATION_DENIED');
  expect(t.request).not.toHaveBeenCalled();
});
it('rejects scope widening and returned vector values before making a request', async () => {
  const t = setup();
  for (const settings of [
    { ...query, filter: { user_id: 'other', video_id: { $in: [1] } } },
    { ...query, filter: { user_id: 'owner', video_id: { $in: [3] } } },
    { ...query, filter: { user_id: 'owner', video_id: { $in: [] } } },
    { ...query, returnValues: true },
    { ...query, topK: 51 },
  ]) await expect(t.index.query(vector, settings)).rejects.toThrow('EVALUATION_VECTOR_SCOPE_DENIED');
  expect(t.request).not.toHaveBeenCalled();
});
it('uses only the scoped query endpoint and keeps authentication out of the body', async () => {
  const t = setup();
  await t.index.query(vector, query);
  const [url, request] = t.request.mock.calls[0];
  if (typeof url !== 'string' || typeof request?.body !== 'string') throw new Error('Expected a JSON HTTP request');
  expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/vectorize/v2/indexes/frozen-scenes/query`);
  expect(request?.method).toBe('POST');
  expect(request?.redirect).toBe('error');
  expect(JSON.parse(request.body)).toMatchObject({ filter: query.filter, topK: 10, returnValues: false });
  expect(request.body).not.toContain('synthetic-secret');
  expect(t.stats.vectorQueries).toBe(1);
});
it('denies model substitution and non-query embedding requests before invoking the provider', async () => {
  const t = setup();
  const body = { input: 'task: search result | query: test seam', dimensions: 768, encoding_format: 'float' };
  await expect(t.ai.run('@cf/other/model', body)).rejects.toThrow('EVALUATION_EMBEDDING_OPERATION_DENIED');
  await expect(t.ai.run(WORKERS_AI_EMBEDDING_MODEL, { ...body, input: 'title: none | text: create a document embedding' })).rejects.toThrow('EVALUATION_EMBEDDING_OPERATION_DENIED');
  expect(t.request).not.toHaveBeenCalled();
});
it('enforces one budget across embedding and vector requests without resetting on errors', async () => {
  const t = setup(1);
  t.request.mockResolvedValue(Response.json({ error: 'synthetic-secret' }, { status: 401 }));
  await expect(t.ai.run(WORKERS_AI_EMBEDDING_MODEL, { input: 'task: search result | query: test seam', dimensions: 768, encoding_format: 'float' })).rejects.toThrow('EVALUATION_SEARCH_HTTP_401');
  await expect(t.index.query(vector, query)).rejects.toThrow('EVALUATION_SEARCH_BUDGET_EXHAUSTED');
  expect(t.request).toHaveBeenCalledTimes(1);
  expect(t.stats).toMatchObject({ embeddingCalls: 1, vectorQueries: 0, failedRequests: 1 });
});
