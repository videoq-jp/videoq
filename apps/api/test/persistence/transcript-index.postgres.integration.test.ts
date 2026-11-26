import { assertPostgresEmbeddingAdmission } from "../../src/runtime/embedding-admission";
import { embeddingFingerprint, resolveEmbeddingConfig } from "../../src/lib/embedding-contract";
import type { Bindings } from "../../src/types/bindings";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isolatedPostgres } from './isolated-postgres';
import { replacePostgresTranscriptIndex, validateTranscriptVectorStorage, clearPostgresTranscriptIndex } from '../../src/persistence/postgres/transcript-index-writer';
import { parseSearchScenes } from '../../src/application/search-scene-splitting';
import { PGEngine, PGVectorStore } from '@videoq-jp/langchainjs-postgres';
import { assertPostgresEmbeddingProvenance, createPostgresSceneSearchRepository } from '../../src/persistence/postgres/scene-search';

const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip).each([768, 1536] as const)('atomic TypeScript pgvector writer (%i)', dimensions => {
  let fixture: Awaited<ReturnType<typeof isolatedPostgres>>, schema: string;
  const table = dimensions === 768 ? 'scene_embeddings_768' as const : 'scene_embeddings' as const;
  const inactive = dimensions === 768 ? 'scene_embeddings' : 'scene_embeddings_768';
  const vector = [1, ...Array(dimensions - 1).fill(0)];
  const transcript = '1\n00:00:00,000 --> 00:00:01,000\n標本化\n\n2\n00:00:01,000 --> 00:00:02,000\n量子化\n';
  const scenes = parseSearchScenes(transcript);
  const snapshot = { videoId: 1, userId: 'owner', transcript };
  const storage = () => ({ table, dimensions, schema });
  const write = (values = [vector, vector]) => replacePostgresTranscriptIndex(fixture.pool, storage(), snapshot, scenes, values);
  beforeAll(async () => {
    fixture = await isolatedPostgres(databaseUrl!, { includePublic: true });
    await fixture.pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    schema = (await fixture.pool.query('SELECT current_schema() AS name')).rows[0].name;
    await fixture.pool.query('CREATE TABLE videos(id integer PRIMARY KEY,user_id text,title text,transcript text)');
    await fixture.pool.query(`CREATE TABLE ${inactive}(video_id integer,user_id text)`);
    await fixture.pool.query(`CREATE TABLE ${table}(langchain_id uuid PRIMARY KEY,content text NOT NULL CHECK(content <> 'reject'),embedding public.vector(${dimensions}),user_id text,video_id integer,langchain_metadata jsonb)`);
  });
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => {
    await fixture.pool.query(`TRUNCATE videos,${table},${inactive}`);
    await fixture.pool.query('INSERT INTO videos VALUES(1,$1,$2,$3)', ['owner','Current title',transcript]);
    await fixture.pool.query(`INSERT INTO ${table} VALUES($1,'old',$2,'owner',1,'{}'),($3,'other owner',$2,'other',2,'{}')`, [crypto.randomUUID(),JSON.stringify(vector),crypto.randomUUID()]);
  });
  it('writes via the actual LangChain store and reads through the existing owner-filtered search', async () => {
    expect(await write()).toBe(2);
    const store = await PGVectorStore.initialize(PGEngine.fromPool(fixture.pool), {
      embedQuery: async () => { throw new Error('precomputed only'); }, embedDocuments: async () => { throw new Error('precomputed only'); },
    }, table, { schemaName: schema, metadataColumns: ['user_id','video_id'] });
    const search = createPostgresSceneSearchRepository(store, dimensions);
    const hits = await search.search({ queryEmbedding: vector, userId: 'owner', videoIds: [1,2], limit: 20 });
    expect(hits.map(h => h.content).sort()).toEqual(['標本化','量子化'].sort());
    expect(hits.every(h => h.videoTitle === 'Current title')).toBe(true);
    expect(await search.search({ queryEmbedding: vector, userId: 'other', videoIds: [1], limit: 20 })).toEqual([]);
    expect((await fixture.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE video_id=2`)).rows[0].n).toBe(1);
  });
  it('rejects unknown and same-dimensional mismatched provenance, and atomically replaces it', async () => {
    const params = { userId: 'owner', videoIds: [1] };
    const env = { EMBEDDING_PROFILE: dimensions === 768 ? 'embeddinggemma2' : 'openai', EMBEDDING_MODEL: 'same-model', EMBEDDING_BASE_URL: 'http://isolated.invalid/v1', EMBEDDING_REVISION: 'weights-1', EMBEDDING_PREPROCESSING: 'raw-text-v1' } as Bindings;
    const fingerprint = await embeddingFingerprint(resolveEmbeddingConfig(env)), changed = 'b'.repeat(64);
    await expect(assertPostgresEmbeddingAdmission(fixture.pool, { ...env, EMBEDDING_REVISION: undefined }, { schema })).rejects.toThrow('explicit immutable revision');
    await expect(assertPostgresEmbeddingAdmission(fixture.pool, env, { schema })).rejects.toThrow('FINGERPRINT_MISMATCH');
    expect(await assertPostgresEmbeddingAdmission(fixture.pool, { ...env, MIGRATION_TRAFFIC_STATE: 'paused' }, { schema })).toEqual({ serving: false, fingerprint });
    await expect(assertPostgresEmbeddingAdmission(fixture.pool, { ...env, MIGRATION_TRAFFIC_STATE: 'paused' }, { schema, resume: true })).rejects.toThrow('FINGERPRINT_MISMATCH');
    await expect(assertPostgresEmbeddingProvenance(fixture.pool, table, params, fingerprint, schema)).rejects.toThrow('FINGERPRINT_MISMATCH');
    expect(await replacePostgresTranscriptIndex(fixture.pool, { ...storage(), fingerprint, identity: 'declared-identity' }, snapshot, scenes, [vector, vector])).toBe(2);
    await expect(assertPostgresEmbeddingProvenance(fixture.pool, table, params, fingerprint, schema)).resolves.toBeUndefined();
    // Other owners remain unknown, so global admission still refuses service.
    await expect(assertPostgresEmbeddingAdmission(fixture.pool, env, { schema })).rejects.toThrow('FINGERPRINT_MISMATCH');
    await fixture.pool.query(`DELETE FROM ${table} WHERE video_id=2`);
    expect(await assertPostgresEmbeddingAdmission(fixture.pool, env, { schema })).toEqual({ serving: true, fingerprint });
    await expect(assertPostgresEmbeddingAdmission(fixture.pool, { ...env, EMBEDDING_REVISION: 'weights-2' }, { schema })).rejects.toThrow('FINGERPRINT_MISMATCH');
    await expect(assertPostgresEmbeddingProvenance(fixture.pool, table, params, changed, schema)).rejects.toThrow('FINGERPRINT_MISMATCH');
    const store = await PGVectorStore.initialize(PGEngine.fromPool(fixture.pool), {
      embedQuery: async () => { throw new Error('precomputed only'); }, embedDocuments: async () => { throw new Error('precomputed only'); },
    }, table, { schemaName: schema, metadataColumns: ['user_id','video_id'] });
    expect(await createPostgresSceneSearchRepository(store, dimensions, fingerprint).search({ queryEmbedding: vector, ...params, limit: 20 })).toHaveLength(2);
    expect(await createPostgresSceneSearchRepository(store, dimensions, changed).search({ queryEmbedding: vector, ...params, limit: 20 })).toEqual([]);
  });
  it('rolls back both deletion and successful earlier inserts if a later insert fails', async () => {
    await expect(replacePostgresTranscriptIndex(fixture.pool,storage(),snapshot,[scenes[0],{...scenes[1],text:'reject'}],[vector,vector])).rejects.toThrow();
    expect((await fixture.pool.query(`SELECT content FROM ${table} WHERE video_id=1`)).rows).toEqual([{content:'old'}]);
    // A failed transaction must not poison the pooled connection.
    expect(await write()).toBe(2);
  });
  it('rejects stale subtitles without deleting the old index', async () => {
    await fixture.pool.query("UPDATE videos SET transcript='new edit' WHERE id=1");
    await expect(write()).rejects.toThrow('transcript changed');
    expect((await fixture.pool.query(`SELECT content FROM ${table} WHERE video_id=1`)).rows).toEqual([{content:'old'}]);
  });
  it('skips deleted videos and mismatched owners', async () => {
    expect(await replacePostgresTranscriptIndex(fixture.pool,storage(),{...snapshot,userId:'other'},scenes,[vector,vector])).toBe(0);
    await fixture.pool.query('DELETE FROM videos WHERE id=1');
    expect(await write()).toBe(0);
  });
  it('rejects invalid vectors and storage dimensions before mutations', async () => {
    await expect(write([[1],[1]])).rejects.toThrow('Invalid scene embeddings');
    await expect(validateTranscriptVectorStorage(fixture.pool,{...storage(),dimensions:dimensions===768?1536:768})).rejects.toThrow('profile mismatch');
    expect((await fixture.pool.query(`SELECT content FROM ${table} WHERE video_id=1`)).rows).toEqual([{content:'old'}]);
  });
  it('clears both profiles atomically for an explicit empty subtitle snapshot', async () => {
    await fixture.pool.query(`INSERT INTO ${inactive}(video_id,user_id) VALUES(1,'owner'),(2,'other')`);
    await fixture.pool.query("UPDATE videos SET transcript='' WHERE id=1");
    expect(await clearPostgresTranscriptIndex(fixture.pool,{...snapshot,transcript:''})).toBe(2);
    for(const name of [table,inactive])expect((await fixture.pool.query(`SELECT video_id FROM ${name}`)).rows).toEqual([{video_id:2}]);
  });
  it('keeps the old committed index visible to another connection until replacement commits', async () => {
    const blocker = await fixture.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM videos WHERE id=1 FOR UPDATE');
    const pending = write();
    try {
      expect((await fixture.pool.query(`SELECT content FROM ${table} WHERE video_id=1`)).rows).toEqual([{content:'old'}]);
      await blocker.query('COMMIT');
      expect(await pending).toBe(2);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });
});
