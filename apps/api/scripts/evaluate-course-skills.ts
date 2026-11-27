/** Opt-in live-model pilot with synthetic data or a private, bounded local snapshot. */
import { parseArgs } from 'node:util';
import { readFile, writeFile, stat, rename, unlink } from 'node:fs/promises';
import { createD1Fixture } from '../test/persistence/d1-fixture';
import { courseSkillManagement } from '../src/integrations/course-skill-management';
import { executeNextCourseSkillBuild } from '../src/integrations/course-skill-execution';
import { createCourseSkillInputs } from '../src/integrations/course-skill-inputs';
import { COURSE_SKILL_KNOWLEDGE_PROMPT_VERSION, COURSE_SKILL_KNOWLEDGE_CHUNK_CHARACTERS } from '../src/integrations/course-skill-knowledge';
import { skillTranscriptChunks, verifySkillKnowledge, type SkillKnowledgeChunk } from '../src/domain/learning/skill-knowledge';
import type { Bindings } from '../src/types/bindings';

const { values } = parseArgs({ options: { 'account-id': { type: 'string' }, 'wrangler-auth-file': { type: 'string' }, output: { type: 'string' }, 'source-file': { type: 'string' }, 'resume-file': { type: 'string' }, 'stop-file': { type: 'string' }, 'max-calls': { type: 'string' }, 'lifecycle-video-id': { type: 'string' }, 'capture-output': { type: 'boolean', default: false }, run: { type: 'boolean', default: false } } });
if (!values.run) {
  console.info('Use --run --account-id <id> --output <path>, with LLM_API_KEY or --wrangler-auth-file <path>. Use --source-file for a private bounded snapshot (at most 3 videos), --max-calls 1..100 (default 12). Use --resume-file to reuse verified subtitle knowledge from a prior private report; planning steps are regenerated. Create --stop-file to stop after a completed tick. Each tick checkpoints private subtitle knowledge. Use --capture-output only for private diagnostics. Only the model endpoint is contacted; no remote DB or media storage is used.');
  console.info('--lifecycle-video-id <id> defers one snapshot video, then adds, removes and re-adds it after completed builds in the same local DB. Tests stale candidate edit rejection without publishing or approving real course knowledge.');
} else {
  if (!values['account-id'] || !/^[a-f0-9]{32}$/.test(values['account-id']) || !values.output) throw new Error('Account ID and output path are required');
  const outputPath = values.output;
  const writeReport = async (value: unknown) => {
    const temporary = `${outputPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    try { await rename(temporary, outputPath); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  };
  let token = process.env.LLM_API_KEY;
  if (values['wrangler-auth-file']) {
    const config = await readFile(values['wrangler-auth-file'], 'utf8');
    token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  }
  if (!token) throw new Error('Model authentication is unavailable');
  const maxCalls = Number(values['max-calls'] ?? 12);
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100) throw new Error('max-calls must be between 1 and 100');
  const source = values['source-file'] ? JSON.parse(await readFile(values['source-file'], 'utf8')) as { courseId: number; courseName: string; videos: { id: number; title: string; transcript: string }[] } : undefined;
  if (source && (!Number.isSafeInteger(source.courseId) || !source.courseName || !Array.isArray(source.videos) || !source.videos.length || source.videos.length > 3 || source.videos.some(v => !Number.isSafeInteger(v.id) || typeof v.title !== 'string' || typeof v.transcript !== 'string'))) throw new Error('Invalid bounded local source snapshot');
  const lifecycleVideoId = values['lifecycle-video-id'] === undefined ? undefined : Number(values['lifecycle-video-id']);
  if (lifecycleVideoId !== undefined && (!Number.isSafeInteger(lifecycleVideoId) || !source || source.videos.length < 2 || !source.videos.some(v => v.id === lifecycleVideoId))) throw new Error('Lifecycle video must belong to a snapshot with at least two videos');
  let modelCalls = 0;
  let stopping = false;
  let stopReason: string | undefined;
  const modelResponses: unknown[] = [];
  const requests: { status: number; code?: string; type?: string; message?: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'api.cloudflare.com' || !url.pathname.startsWith(`/client/v4/accounts/${values['account-id']}/ai/`)) throw new Error('PILOT_OUTBOUND_NOT_ALLOWED');
    if (modelCalls >= maxCalls) throw new Error('PILOT_MODEL_CALL_LIMIT');
    modelCalls++;
    const response = await originalFetch(input, init);
    if (response.status === 401 || response.status === 403) { stopping = true; stopReason = 'provider_authentication'; }
    if (!response.ok && new URL(input instanceof Request ? input.url : String(input)).hostname === 'api.cloudflare.com') {
      const body = await response.clone().json().catch(() => ({})) as { error?: { code?: unknown; type?: unknown; message?: unknown }; errors?: { code?: unknown; message?: unknown }[] };
      const error = body.error ?? body.errors?.[0];
      requests.push({ status: response.status, code: typeof error?.code === 'string' || typeof error?.code === 'number' ? String(error.code) : undefined,
        type: body.error?.type && typeof body.error.type === 'string' ? body.error.type : undefined,
        message: typeof error?.message === 'string' ? error.message.replaceAll(token, '[redacted]').slice(0, 1000) : undefined });
    }
    if (values['capture-output'] && response.ok) modelResponses.push(await response.clone().json());
    return response;
  };
  const fixture = await createD1Fixture();
  const env = { DB: fixture.database, DEPLOYMENT_EDITION: 'cloud', PERSISTENCE_BACKEND: 'd1',
    TASK_SCHEDULER: { getByName: () => ({ armAt: () => Promise.resolve() }) },
    LLM_MODEL: '@cf/google/gemma-4-26b-a4b-it', LLM_MAX_TOKENS: '4096', LLM_API_KEY: token,
    LLM_BASE_URL: `https://api.cloudflare.com/client/v4/accounts/${values['account-id']}/ai/v1`,
  } as unknown as Bindings; // Isolated fixture supplies only bindings used by this pilot.
  const lecture = [
    '1\n00:00:01,000 --> 00:00:20,000\n再試行を追加する前に、同じ要求が二回届いた場合に副作用が重複するか確認します。要求を識別する冪等性キーは、再試行のたびに作り直さず、同じ論理要求では同じキーを使います。',
    '2\n00:00:21,000 --> 00:00:40,000\nデータベース内で完結する処理では、キーの一意制約、業務上の変更、処理結果の保存を同じトランザクションで行います。処理済みなら保存した結果を返します。外部の決済やメール送信は、そのDBトランザクションだけでは一度の実行を保証できません。外部サービスの冪等性キーや、永続アウトボックスなどを別に検討します。',
    '3\n00:00:41,000 --> 00:01:00,000\n検証では、同じキーの逐次要求だけでなく同時要求も試します。コミット後に応答が失われ、同じキーで再試行された場合も検証します。副作用が重複せず、保存済みの同じ結果を返すことを確かめます。教材で定めていない待ち時間や試行回数を勝手に一般則として追加しないでください。',
  ].join('\n\n');
  const sql = async (query: string, args: (string | number)[] = []) => { await fixture.database.prepare(query).bind(...args).run(); };
  const readKnowledge = async () => (await fixture.database.prepare('SELECT key,content FROM course_skill_knowledge_chunks').all()).results.map(row => ({ key: row.key, content: JSON.parse(String(row.content)) as SkillKnowledgeChunk }));
  const started = Date.now();
  let report: Record<string, unknown> = { model: env.LLM_MODEL, maxTokens: env.LLM_MAX_TOKENS, source: source ? `course-${source.courseId}-bounded-snapshot` : 'synthetic-retry-lecture-v1', scope: source ? { courseId: source.courseId, videoIds: source.videos.map(v => v.id), visualsCopied: false } : undefined, evaluation: 'generation-pilot-only', effectComparisonCompleted: false };
  try {
    await sql("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,ai_answers_limit) VALUES('pilot','pilot','pilot@example.test',0,0,0,0,?)", [maxCalls]);
    const courseId = source?.courseId ?? 1;
    for (const [order, video] of (source?.videos ?? [{ id: 1, title: 'Retry lecture', transcript: lecture }]).entries()) {
      await sql("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(?,'pilot',?,?,'completed',?,'','2026-11-27','','uploaded','','')", [video.id, video.title, `isolated-${video.id}.mp4`, video.transcript]);
      const revision = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(video.transcript)))].map(n => n.toString(16).padStart(2, '0')).join('');
      await sql('INSERT INTO video_index_versions(video_id,revision) VALUES(?,?) ON CONFLICT(video_id) DO UPDATE SET revision=excluded.revision', [video.id, revision]);
      if (order === 0) await sql("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(?,'pilot',?,'','2026-11-27','2026-11-27',0)", [courseId, source?.courseName ?? 'Skill generation pilot']);
      if (video.id !== lifecycleVideoId) await sql('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(?,?,?,?)', [courseId, video.id, '2026-11-27', order]);
    }
    const owner = courseSkillManagement(env, 'pilot');
    await owner.configure(courseId, { generationEnabled: true, distributionEnabled: false, language: 'ja', policyVersion: '1' });
    if (values['resume-file']) {
      const previous = JSON.parse(await readFile(values['resume-file'], 'utf8')) as { knowledge?: { key: string; content: SkillKnowledgeChunk }[] };
      if (!Array.isArray(previous.knowledge) || previous.knowledge.length > 1000) throw new Error('INVALID_PILOT_RESUME');
      const expected = new Map<string, { cues: SkillKnowledgeChunk['cues']; revision: string }>();
      for (const video of source?.videos ?? [{ id: 1, title: 'Retry lecture', transcript: lecture }]) {
        // Deferred videos are seeded locally but are not course members yet.
        // Cache validation still uses their actual local analysis revision and all original cues.
        const revision = (await fixture.database.prepare('SELECT revision FROM video_index_versions WHERE video_id=?').bind(video.id).first<{ revision: string }>())?.revision;
        if (!revision) throw new Error('INVALID_PILOT_RESUME');
        const chars = [...video.transcript];
        for await (const chunk of skillTranscriptChunks(offset => Promise.resolve({ text: chars.slice(offset, offset + 12000).join(''), nextOffset: Math.min(offset + 12000, chars.length), done: offset + 12000 >= chars.length }), COURSE_SKILL_KNOWLEDGE_CHUNK_CHARACTERS)) expected.set(`${video.id}:${chunk.index}`, { cues: chunk.cues, revision });
      }
      const seen = new Set<string>();
      for (const row of previous.knowledge) {
        const chunk = row.content;
        const current = expected.get(`${chunk.videoId}:${chunk.chunkIndex}`);
        if (!current || chunk.version !== 1 || chunk.model !== env.LLM_MODEL || chunk.promptVersion !== COURSE_SKILL_KNOWLEDGE_PROMPT_VERSION || chunk.analysisRevision !== current.revision || JSON.stringify(chunk.cues) !== JSON.stringify(current.cues) || chunk.frames?.length || seen.has(row.key)) throw new Error('INVALID_PILOT_RESUME');
        verifySkillKnowledge(chunk.facts, current.cues);
        if (chunk.facts.some((f, i) => f.id !== `${row.key}:${i}` || f.status !== (f.requiresVisualEvidence ? 'needs_visual_review' : 'supported'))) throw new Error('INVALID_PILOT_RESUME');
        const data = JSON.stringify({ ownerId: 'pilot', videoId: chunk.videoId, analysisRevision: current.revision, policyVersion: '1', language: 'ja', model: env.LLM_MODEL, promptVersion: COURSE_SKILL_KNOWLEDGE_PROMPT_VERSION, chunk: { index: chunk.chunkIndex, cues: current.cues } });
        const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))].map(n => n.toString(16).padStart(2, '0')).join('');
        const content = JSON.stringify(chunk);
        if (key !== row.key || Buffer.byteLength(content) > 240000) throw new Error('INVALID_PILOT_RESUME');
        seen.add(key);
        await sql('INSERT INTO course_skill_knowledge_chunks(key,owner_id,video_id,content) VALUES(?,?,?,?)', [key, 'pilot', chunk.videoId, content]);
      }
      report.resumedKnowledgeChunks = seen.size;
    }
    if (values['stop-file'] && await stat(values['stop-file']).then(() => true, () => false)) { stopping = true; stopReason = 'stop_file'; }
    let lifecycleStage: 'initial' | 'added' | 'removed' | 'readded' = 'initial';
    const lifecycle: unknown[] = [];
    report.lifecycle = lifecycle;
    for (let tick = 0; tick < maxCalls + 32 && !stopping; tick++) {
      await executeNextCourseSkillBuild(env);
      const state = await owner.list(courseId);
      const chunks = await fixture.database.prepare('SELECT count(*) AS count FROM course_skill_knowledge_chunks').first<{ count: number }>();
      report = { ...report, partial: true, state, modelCalls, knowledgeChunks: chunks?.count ?? 0, knowledge: await readKnowledge(), requests: [...requests], ...(values['capture-output'] ? { modelResponses: [...modelResponses] } : {}) };
      await writeReport(report);
      console.info(JSON.stringify({ tick, state: state.jobs[0]?.state, phase: state.jobs[0]?.phase, candidates: state.candidates.length, knowledgeChunks: chunks?.count ?? 0, modelCalls }));
      if (values['stop-file'] && await stat(values['stop-file']).then(() => true, () => false)) { stopping = true; stopReason = 'stop_file'; }
      if (state.jobs[0]?.state === 'completed' && lifecycleVideoId !== undefined && !stopping) {
        const details = await Promise.all(state.candidates.map(c => owner.get(courseId, c.id)));
        if (lifecycleStage === 'removed' && details.some(d => d.sources.some(s => s.videoId === lifecycleVideoId))) throw new Error('PILOT_REMOVED_KNOWLEDGE_RETAINED');
        lifecycle.push({ stage: lifecycleStage, modelCalls, state, details, memberships: (await fixture.database.prepare('SELECT id,video_id FROM video_course_members WHERE course_id=? ORDER BY id').bind(courseId).all()).results });
        if (lifecycleStage === 'readded' || modelCalls >= maxCalls) break;
        if (lifecycleStage === 'added') {
          await sql('DELETE FROM video_course_members WHERE course_id=? AND video_id=?', [courseId, lifecycleVideoId]);
          lifecycleStage = 'removed';
        } else {
          await sql('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(?,?,?,?)', [courseId, lifecycleVideoId, new Date().toISOString(), source!.videos.findIndex(v => v.id === lifecycleVideoId)]);
          lifecycleStage = lifecycleStage === 'initial' ? 'added' : 'readded';
        }
        const callsBeforeFenceCheck = modelCalls;
        const changed = await owner.list(courseId);
        if (changed.candidates.some(c => c.canPublish || c.editable)) throw new Error('PILOT_STALE_CANDIDATE_EDITABLE');
        const draft = details.find(d => d.draft);
        let staleEditRejected: boolean | null = null;
        if (draft?.draft) {
          try { await owner.update(courseId, draft.id, draft.contentHash, draft.draft); staleEditRejected = false; }
          catch (error) { if (!(error instanceof Error && 'kind' in error && error.kind === 'conflict')) throw error; staleEditRejected = true; }
          if (!staleEditRejected || modelCalls !== callsBeforeFenceCheck) throw new Error('PILOT_STALE_EDIT_FENCE_FAILED');
        }
        lifecycle.push({ transitionTo: lifecycleStage, staleCandidatesBlocked: true, staleEditRejected, modelCallsUnchanged: modelCalls === callsBeforeFenceCheck });
        await (await createCourseSkillInputs(env)).reconcile(courseId, 'pilot');
      } else if (['completed', 'failed'].includes(state.jobs[0]?.state)) break;
      if (modelCalls >= maxCalls || stopping) break;
      await sql('UPDATE course_skill_builds SET lease_until=0');
    }
    const state = await owner.list(courseId);
    report = { ...report, partial: false, elapsedMs: Date.now() - started, state, details: await Promise.all(state.candidates.map(c => owner.get(courseId, c.id))),
      knowledge: await readKnowledge(),
      candidates: (await fixture.database.prepare('SELECT content FROM course_skill_candidates').all()).results.map(row => JSON.parse(String(row.content)) as unknown),
      quota: await fixture.database.prepare("SELECT used_ai_answers FROM users WHERE id='pilot'").first(),
      ledger: (await fixture.database.prepare('SELECT status,quota_consumed,provider_calls FROM ai_answer_attempts').all()).results };
  } catch {
    process.exitCode = 1;
    report = { ...report, elapsedMs: Date.now() - started, error: 'PILOT_EXECUTION_FAILED' };
  } finally {
    report.stopped = stopping;
    report.stopReason = stopReason;
    report.requests = requests;
    if (values['capture-output']) report.modelResponses = modelResponses;
    report.modelCalls = modelCalls;
    report.callLimit = maxCalls;
    globalThis.fetch = originalFetch;
    try { await writeReport(report); }
    finally { await fixture.dispose(); }
  }
}
