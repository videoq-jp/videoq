import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Vectorize } from '@cloudflare/workers-types';
import { createD1Fixture } from './d1-fixture';
import { createD1SceneIndexWriter } from '../../src/persistence/d1/scene-index-writer';
import { synchronizeD1SceneIndex } from '../../src/persistence/d1/scene-index-sync';
import { createD1SceneSearchRepository } from '../../src/persistence/d1/scene-search';
import { embeddingFingerprint, embeddingIdentity, resolveEmbeddingConfig } from '../../src/lib/embedding-contract';

let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
beforeAll(async () => { fixture = await createD1Fixture({ beforeMigration: '0020_embedding_fingerprint.sql' }); });
afterAll(async () => { await fixture?.dispose(); });
const config = resolveEmbeddingConfig({ EMBEDDING_MODEL: 'same-model', EMBEDDING_REVISION: 'weights-1' });
const vector = Array(1536).fill(.25);
const { preflight } = createRequire(import.meta.url)('../../../../.github/scripts/embedding-release-preflight.cjs') as {
  preflight(target: unknown, env: Record<string, string>, fetcher: (url: string, options: { body: string }) => Promise<Response>, options?: { resume: boolean }): Promise<{ serving: boolean }>;
};
const releaseTarget = { vars: { EMBEDDING_MODEL: 'same-model', EMBEDDING_REVISION: 'weights-1' }, d1_databases: [{ binding: 'DB', database_id: '11111111-2222-4333-8444-555555555555' }] };
const releaseEnv = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-local-test' };
const releaseCheck = (resume = false, paused = false) => preflight({ ...releaseTarget, vars: { ...releaseTarget.vars, ...(paused ? { MIGRATION_TRAFFIC_STATE: 'paused' } : {}) } }, releaseEnv,
  async (_url, options) => {
    const { sql, params } = JSON.parse(options.body);
    return Response.json({ success: true, result: [await fixture.database.prepare(sql).bind(...params).all()] });
  }, { resume });


it('uses identical canonical identity in Python and TypeScript and detects same-dimension changes', async () => {
  const fingerprint = await embeddingFingerprint(config);
  expect(fingerprint).toBe("72c3a9b62f132cd1730ade65f15d69e79d91c1122c97650bfceaa79f99ee439d"); // Shared Python/TypeScript golden vector.
  for (const change of [{ model: 'different-model' }, { revision: 'weights-2' }, { preprocessing: 'normalize-v2' }, { provider: 'workers-ai' as const }]) {
    expect(await embeddingFingerprint({ ...config, ...change })).not.toBe(fingerprint);
  }
});

it('migrates unknown generations without adopting them, rejects reads/writes and atomically rebuilds', async () => {
  const db = fixture.database;
  await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',0,0,0,0)").run();
  await db.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Legacy','legacy.mp4','completed','original','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'','uploaded','','')").run();
  await db.prepare("INSERT INTO video_index_versions(video_id,revision) VALUES(1,'source')").run();
  await db.prepare("INSERT INTO scene_index_runs(id,video_id,user_id,source_revision,dimensions,expected_scenes,status) VALUES('legacy',1,'owner','source',1536,1,'published')").run();
  await db.prepare("INSERT INTO video_index_heads(video_id,dimensions,run_id) VALUES(1,1536,'legacy')").run();
  await db.prepare("INSERT INTO scenes(id,video_id,content,start_time,end_time,dimensions,revision,vector_id) VALUES('old',1,'old','0','1',1536,'legacy','old-vector')").run();
  await expect(releaseCheck()).rejects.toThrow(); // Missing provenance schema blocks release too.
  expect(await releaseCheck(false, true)).toEqual(expect.objectContaining({ serving: false }));
  // The old binary still reads its existing columns after this additive migration.
  const migration = readFileSync(new URL('../../drizzle-d1/0020_embedding_fingerprint.sql', import.meta.url), 'utf8');
  await db.batch(migration.split('--> statement-breakpoint').map(sql => db.prepare(sql)));
  expect(await db.prepare("SELECT embedding_fingerprint FROM scene_index_runs WHERE id='legacy'").first('embedding_fingerprint')).toBeNull();
  expect(await db.prepare("SELECT content FROM scenes").first('content')).toBe('old');
  await expect(releaseCheck()).rejects.toThrow('REBUILD_REQUIRED');
  await expect(releaseCheck(true, true)).rejects.toThrow('REBUILD_REQUIRED');
  const fingerprint = await embeddingFingerprint(config);
  const writer = createD1SceneIndexWriter(db, fingerprint, embeddingIdentity(config));
  const query = vi.fn().mockResolvedValue({ matches: [] });
  const search = createD1SceneSearchRepository(db, { query } as unknown as Vectorize, 1536, fingerprint);
  const input = { queryEmbedding: vector, userId: 'owner', videoIds: [1], limit: 5 };
  await expect(search.search(input)).rejects.toThrow('FINGERPRINT_MISMATCH');
  expect(query).not.toHaveBeenCalled();
  await expect(writer.stage('legacy', 'owner', [])).rejects.toThrow('FINGERPRINT_MISMATCH');
  const run = { runId: 'new', videoId: 1, userId: 'owner', sourceRevision: 'source', dimensions: 1536 as const, expectedScenes: 1 };
  await expect(writer.start({ ...run, embeddingFingerprint: 'a'.repeat(64) })).rejects.toThrow('FINGERPRINT_MISMATCH');
  expect(await writer.start({ ...run, embeddingFingerprint: fingerprint })).toBe(true);
  expect(await db.prepare('SELECT content FROM scenes').first('content')).toBe('old');
  await expect(search.search(input)).rejects.toThrow('FINGERPRINT_MISMATCH');
  expect(await writer.stage('new', 'owner', [{ id: 'new-scene', content: 'new', startTime: '0', endTime: '1', embedding: vector }])).toBe(true);
  const different = createD1SceneIndexWriter(db, await embeddingFingerprint({ ...config, revision: 'weights-2' }));
  await expect(different.stage('new', 'owner', [])).rejects.toThrow('FINGERPRINT_MISMATCH');
  await expect(different.publish('new', 'owner')).rejects.toThrow('FINGERPRINT_MISMATCH');
  const upsert = vi.fn().mockResolvedValue({ mutationId: 'local-test' });
  const index = { upsert, getByIds: async () => [], queryById: async () => ({ matches: [] }) } as unknown as Vectorize;
  const wrongFingerprint = await embeddingFingerprint({ ...config, revision: 'weights-2' });
  expect(await synchronizeD1SceneIndex(db, { 1536: index }, 1, { fingerprint: wrongFingerprint })).toMatchObject({ failed: 1, completed: 0 });
  expect(upsert).not.toHaveBeenCalled();
  await db.prepare("UPDATE scene_index_tasks SET available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation='upsert'").run();
  expect(await synchronizeD1SceneIndex(db, { 1536: index }, 1, { fingerprint })).toMatchObject({ pending: 1 });
  expect(upsert).toHaveBeenCalledOnce();
  expect(await writer.publish('new', 'owner')).toBe(true);
  expect(await db.prepare('SELECT content FROM scenes').first('content')).toBe('new');
  expect(await releaseCheck()).toEqual(expect.objectContaining({ serving: true }));
  const vectorId = await db.prepare("SELECT vector_id FROM scenes WHERE id='new-scene'").first('vector_id');
  query.mockResolvedValue({ matches: [{ id: vectorId, score: .9, metadata: { vector_id: vectorId, scene_id: 'new-scene', revision: 'new', user_id: 'owner', video_id: 1, text: 'untrusted' } }] });
  expect(await search.search(input)).toEqual([{ content: 'new', videoId: 1, videoTitle: 'Legacy', startTime: '0', endTime: '1', evidenceType: 'transcript' }]);
  expect(query).toHaveBeenCalledOnce();
  const changedSearch = createD1SceneSearchRepository(db, { query } as unknown as Vectorize, 1536, await embeddingFingerprint({ ...config, revision: 'weights-2' }));
  await expect(changedSearch.search(input)).rejects.toThrow('FINGERPRINT_MISMATCH');
  // An old writer still understands the additive schema, but cannot silently
  // certify new provenance. A mixed-version producer must block strict cutover.
  const oldWriter = createD1SceneIndexWriter(db);
  // Superseded unheaded runs are immutable history, not resumable writers.
  // Neither a retry of start nor stage/publish can recreate their head.
  for (const [id, declared] of [['orphan-null', null], ['orphan-mismatch', 'a'.repeat(64)]] as const) {
    await db.prepare("INSERT INTO scene_index_runs(id,video_id,user_id,source_revision,dimensions,expected_scenes,status,embedding_fingerprint) VALUES(?,1,'owner','source',1536,0,'staging',?)").bind(id, declared).run();
    expect(await oldWriter.start({ ...run, runId: id, expectedScenes: 0 })).toBe(false);
    expect(await oldWriter.stage(id, 'owner', [])).toBe(false);
    expect(await oldWriter.publish(id, 'owner')).toBe(false);
    expect(await releaseCheck()).toEqual(expect.objectContaining({ serving: true }));
  }

  expect(await oldWriter.start({ ...run, runId: 'old-binary', expectedScenes: 0 })).toBe(true);
  await expect(releaseCheck()).rejects.toThrow('REBUILD_REQUIRED');
  expect(await oldWriter.publish('old-binary', 'owner')).toBe(true);
  await expect(releaseCheck()).rejects.toThrow('REBUILD_REQUIRED');
  await expect(writer.publish('old-binary', 'owner')).rejects.toThrow('FINGERPRINT_MISMATCH');
  // Retire the old writer, then rebuild from a strict identity before resume.
  expect(await writer.start({ ...run, runId: 'final-rebuild', expectedScenes: 0, embeddingFingerprint: fingerprint })).toBe(true);
  expect(await writer.publish('final-rebuild', 'owner')).toBe(true);
  expect(await releaseCheck(true, true)).toEqual(expect.objectContaining({ serving: true }));
}, 20_000);
