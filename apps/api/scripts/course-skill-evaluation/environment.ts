/** Frozen real-course fixture; all course writes are local, external operations are search-only. */
import { readFile } from 'node:fs/promises';
import { createD1Fixture } from '../../test/persistence/d1-fixture';
import { openPersistentEvaluationDatabase } from './persistent-database';
import { createMemoryRateLimitBackend } from '../../src/lib/rate-limit';
import { embeddingFingerprint, embeddingIdentity, resolveEmbeddingConfig, WORKERS_AI_EMBEDDING_MODEL } from '../../src/lib/embedding-contract';
import type { Bindings } from '../../src/types/bindings';

export type FrozenVideo = { id: number; title: string; transcript: string; user_id: string; status: string; revision: string };
export type FrozenRun = { id: string; video_id: number; user_id: string; source_revision: string; dimensions: number; embedding_identity: string; embedding_fingerprint: string; expected_scenes: number; status: string };
export type FrozenScene = { id: string; video_id: number; content: string; start_time: string; end_time: string; evidence_type: string; dimensions: number; revision: string; vector_id: string | null };
export type FrozenCourse = { courseId: number; videos: FrozenVideo[]; runs: FrozenRun[]; scenes: FrozenScene[] };
const localEnvironments = new WeakSet<Bindings>();
export function assertLocalEvaluationEnvironment(env: Bindings) {
  if (!localEnvironments.has(env)) throw new Error('LOCAL_EVALUATION_ENVIRONMENT_REQUIRED');
}
export const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');

export async function readFrozenCourse(paths: { videos: string; runs: string; scenes: string; originalInput: string; courseId: number }): Promise<FrozenCourse> {
  async function d1(path: string) {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > 8_000_000) throw new Error('FROZEN_INPUT_TOO_LARGE');
    const payload = JSON.parse(raw) as { success?: boolean; result?: { results: unknown[] }[] };
    if (payload.success !== true || !Array.isArray(payload.result?.[0]?.results)) throw new Error('FROZEN_SOURCE_READ_FAILED');
    return payload.result[0].results;
  }
  const videos = await d1(paths.videos) as FrozenVideo[];
  const scenes = await d1(paths.scenes) as FrozenScene[];
  const runs = JSON.parse(await readFile(paths.runs, 'utf8')) as FrozenRun[];
  const original = JSON.parse(await readFile(paths.originalInput, 'utf8')) as { courseId: number; videos: { id: number; transcript: string }[] };
  if (original.courseId !== paths.courseId || !videos.length || videos.length > 3 || new Set(videos.map(v => v.id)).size !== videos.length || new Set(videos.map(v => v.user_id)).size !== 1) throw new Error('INVALID_FROZEN_SCOPE');
  for (const video of videos) {
    if (!Number.isSafeInteger(video.id) || video.id <= 0 || video.status !== 'completed' || !video.revision || !video.user_id || !video.transcript || video.transcript !== original.videos.find(v => v.id === video.id)?.transcript) throw new Error('FROZEN_TRANSCRIPT_CHANGED');
    const selected = runs.filter(r => r.video_id === video.id);
    if (selected.length !== 1) throw new Error('FROZEN_INDEX_MISSING');
    const run = selected[0];
    if (run.status !== 'published' || run.dimensions !== 768 || run.user_id !== video.user_id || run.source_revision !== video.revision || run.expected_scenes !== scenes.filter(s => s.video_id === video.id).length) throw new Error('FROZEN_INDEX_STALE');
  }
  if (runs.length !== videos.length || scenes.some(s => !runs.some(r => r.video_id === s.video_id && r.id === s.revision && r.dimensions === s.dimensions))) throw new Error('FROZEN_SCENE_SCOPE_INVALID');
  return { courseId: paths.courseId, videos, runs, scenes };
}

export function readOnlySearchTransport(options: { accountId: string; indexName: string; ownerId: string; videoIds: number[]; token: () => Promise<string>; maxCalls: number; fetch?: typeof fetch }) {
  if (!/^[a-f0-9]{32}$/.test(options.accountId) || !/^[a-z0-9-]+$/.test(options.indexName) || !Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 1000) throw new Error('INVALID_SEARCH_TRANSPORT');
  const allowedVideos = new Set(options.videoIds);
  const stats = { embeddingCalls: 0, vectorQueries: 0, inputTokens: 0, failedRequests: 0 };
  const perform = async (path: string, body: unknown, signal?: AbortSignal) => {
    if (stats.embeddingCalls + stats.vectorQueries > options.maxCalls) throw new Error('EVALUATION_SEARCH_BUDGET_EXHAUSTED');
    const response = await (options.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/${path}`, {
      redirect: 'error', method: 'POST', headers: { Authorization: `Bearer ${await options.token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    });
    if (!response.ok) { stats.failedRequests++; throw new Error(`EVALUATION_SEARCH_HTTP_${response.status}`); }
    const value = await response.json<{ success: boolean; result: unknown }>();
    if (value.success !== true || !value.result) throw new Error('EVALUATION_SEARCH_RESPONSE_INVALID');
    return value.result;
  };
  const deny = () => Promise.reject(new Error('EVALUATION_INDEX_OPERATION_DENIED'));
  return {
    stats,
    ai: {
      async run(model: string, body: { input: string | string[]; dimensions: number; encoding_format: string }, settings?: { signal?: AbortSignal; returnRawResponse?: boolean }) {
        const inputs = typeof body.input === 'string' ? [body.input] : body.input;
        if (model !== WORKERS_AI_EMBEDDING_MODEL || body.dimensions !== 768 || body.encoding_format !== 'float' || !Array.isArray(inputs) || inputs.length !== 1 || inputs.some(t => typeof t !== 'string' || !t.startsWith('task: search result | query: ') || t.length > 12_000)) throw new Error('EVALUATION_EMBEDDING_OPERATION_DENIED');
        if (stats.embeddingCalls + stats.vectorQueries >= options.maxCalls) throw new Error('EVALUATION_SEARCH_BUDGET_EXHAUSTED');
        stats.embeddingCalls++;
        const result = await perform(`ai/run/${WORKERS_AI_EMBEDDING_MODEL}`, body, settings?.signal) as { usage?: { prompt_tokens?: number } };
        stats.inputTokens += result.usage?.prompt_tokens ?? 0;
        return settings?.returnRawResponse ? Response.json(result) : result;
      },
    },
    index: {
      describe: deny, insert: deny, upsert: deny, deleteByIds: deny, getByIds: deny, queryById: deny,
      async query(vector: number[], settings: { filter?: { user_id?: string; video_id?: { $in?: number[] } }; topK?: number; returnMetadata?: string; returnValues?: boolean }) {
        const filter = settings.filter;
        if (vector.length !== 768 || vector.some(v => !Number.isFinite(v)) || !filter || Object.keys(filter).sort().join(',') !== 'user_id,video_id' || filter.user_id !== options.ownerId || !filter.video_id?.$in?.length || filter.video_id.$in.some(id => !allowedVideos.has(id)) || Object.keys(filter.video_id).join(',') !== '$in' || settings.returnValues || (settings.topK ?? 0) < 1 || settings.topK! > 50 || !['none', 'indexed', 'all'].includes(settings.returnMetadata ?? 'none')) throw new Error('EVALUATION_VECTOR_SCOPE_DENIED');
        if (stats.embeddingCalls + stats.vectorQueries >= options.maxCalls) throw new Error('EVALUATION_SEARCH_BUDGET_EXHAUSTED');
        stats.vectorQueries++;
        return await perform(`vectorize/v2/indexes/${options.indexName}/query`, { vector, ...settings });
      },
    },
  };
}

export async function createFrozenEvaluationEnvironment(source: FrozenCourse, transport: ReturnType<typeof readOnlySearchTransport>, options: { directory?: string } = {}) {
  if (!source.videos.length) throw new Error('INVALID_FROZEN_SCOPE');
  const env = { PERSISTENCE_BACKEND: 'd1', DEPLOYMENT_EDITION: 'cloud',
    RATE_LIMIT_BACKEND: createMemoryRateLimitBackend(), TASK_SCHEDULER: { getByName: () => ({ armAt: () => Promise.resolve() }) },
    EMBEDDING_PROVIDER: 'workers-ai', EMBEDDING_PROFILE: 'embeddinggemma2', AI: transport.ai, SCENE_VECTORIZE_768: transport.index,
  } as unknown as Bindings;
  const config = resolveEmbeddingConfig(env), fingerprint = await embeddingFingerprint(config);
  const ownerId = source.videos[0].user_id;
  const revisions = new Map<number, string>();
  for (const video of source.videos) revisions.set(video.id, await sha256(video.transcript));
  if (source.runs.some(r => r.embedding_identity !== embeddingIdentity(config) || r.embedding_fingerprint !== fingerprint)) throw new Error('EVALUATION_EMBEDDING_IDENTITY_MISMATCH');
  const initialize = async (database: D1Database) => {
    const sql = async (query: string, args: (string | number | null)[] = []) => { await database.prepare(query).bind(...args).run(); };
    await sql("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,ai_answers_limit) VALUES(?,'local-evaluation','local-evaluation@example.test',0,0,0,0,1000)", [ownerId]);
    await sql("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(?,?,'Isolated evaluation','','2026-11-27','2026-11-27',0)", [source.courseId, ownerId]);
    for (const [order, video] of source.videos.entries()) {
      const revision = revisions.get(video.id)!;
      await sql("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(?,?,?,?,'completed',?,'','2026-11-27','','uploaded','','')", [video.id, ownerId, video.title, `isolated-${video.id}.mp4`, video.transcript]);
      await sql('INSERT INTO video_index_versions(video_id,revision) VALUES(?,?) ON CONFLICT(video_id) DO UPDATE SET revision=excluded.revision', [video.id, revision]);
      await sql('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(?,?,?,?)', [source.courseId, video.id, '2026-11-27', order]);
    }
    for (const run of source.runs) {
      // Local source tokens use transcript SHA-256, as in the generation pilot.
      // The frozen transcript is verified byte-identical; vector run IDs, identity,
      // fingerprint and all scene content remain the originals.
      await sql('INSERT INTO scene_index_runs(id,video_id,user_id,source_revision,dimensions,embedding_identity,embedding_fingerprint,expected_scenes,pending_vectors,status) VALUES(?,?,?,?,?,?,?,?,0,?)', [run.id, run.video_id, ownerId, revisions.get(run.video_id)!, run.dimensions, run.embedding_identity, run.embedding_fingerprint, run.expected_scenes, 'published']);
      await sql('INSERT INTO video_index_heads(video_id,dimensions,run_id) VALUES(?,?,?)', [run.video_id, run.dimensions, run.id]);
    }
    for (const scene of source.scenes) await sql('INSERT INTO scenes(id,video_id,content,start_time,end_time,evidence_type,dimensions,revision,vector_id) VALUES(?,?,?,?,?,?,?,?,?)', [scene.id, scene.video_id, scene.content, scene.start_time, scene.end_time, scene.evidence_type, scene.dimensions, scene.revision, scene.vector_id]);
  };
  const fixture = options.directory
    ? await openPersistentEvaluationDatabase({ directory: options.directory, inputHash: await sha256(JSON.stringify(source)), initialize })
    : await createD1Fixture();
  try {
    if (!options.directory) await initialize(fixture.database);
    env.DB = fixture.database;
    localEnvironments.add(env);
    return { env, ownerId, source, revisions, resumed: 'resumed' in fixture && fixture.resumed, stats: transport.stats, dispose: async () => { localEnvironments.delete(env); await fixture.dispose(); } };
  } catch (error) { await fixture.dispose(); throw error; }
}
