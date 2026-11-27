/** Opt-in live-model pilot; all data is synthetic and the DB is disposable. */
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createD1Fixture } from '../test/persistence/d1-fixture';
import { courseSkillManagement } from '../src/integrations/course-skill-management';
import { executeNextCourseSkillBuild } from '../src/integrations/course-skill-execution';
import type { Bindings } from '../src/types/bindings';

const { values } = parseArgs({ options: { 'account-id': { type: 'string' }, 'wrangler-auth-file': { type: 'string' }, output: { type: 'string' }, run: { type: 'boolean', default: false } } });
if (!values.run) {
  console.info('Use --run --account-id <id> --output <path>, with LLM_API_KEY or --wrangler-auth-file <path>. Makes at most 12 billed model calls. No remote DB or media storage is used.');
} else {
  if (!values['account-id'] || !/^[a-f0-9]{32}$/.test(values['account-id']) || !values.output) throw new Error('Account ID and output path are required');
  let token = process.env.LLM_API_KEY;
  if (values['wrangler-auth-file']) {
    const config = await readFile(values['wrangler-auth-file'], 'utf8');
    token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  }
  if (!token) throw new Error('Model authentication is unavailable');
  const requests: { status: number; code?: string; type?: string; message?: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!response.ok && new URL(input instanceof Request ? input.url : String(input)).hostname === 'api.cloudflare.com') {
      const body = await response.clone().json().catch(() => ({})) as { error?: { code?: unknown; type?: unknown; message?: unknown }; errors?: { code?: unknown; message?: unknown }[] };
      const error = body.error ?? body.errors?.[0];
      requests.push({ status: response.status, code: typeof error?.code === 'string' || typeof error?.code === 'number' ? String(error.code) : undefined,
        type: body.error?.type && typeof body.error.type === 'string' ? body.error.type : undefined,
        message: typeof error?.message === 'string' ? error.message.replaceAll(token, '[redacted]').slice(0, 1000) : undefined });
    }
    return response;
  };
  const fixture = await createD1Fixture();
  const env = { DB: fixture.database, DEPLOYMENT_EDITION: 'cloud', PERSISTENCE_BACKEND: 'd1',
    TASK_SCHEDULER: { getByName: () => ({ armAt: () => Promise.resolve() }) },
    LLM_MODEL: '@cf/google/gemma-4-26b-a4b-it', LLM_MAX_TOKENS: '4096', LLM_API_KEY: token,
    LLM_BASE_URL: `https://api.cloudflare.com/client/v4/accounts/${values['account-id']}/ai/v1`,
  } as Bindings;
  const lecture = [
    '1\n00:00:01,000 --> 00:00:20,000\n再試行を追加する前に、同じ要求が二回届いた場合に副作用が重複するか確認します。要求を識別する冪等性キーは、再試行のたびに作り直さず、同じ論理要求では同じキーを使います。',
    '2\n00:00:21,000 --> 00:00:40,000\nデータベース内で完結する処理では、キーの一意制約、業務上の変更、処理結果の保存を同じトランザクションで行います。処理済みなら保存した結果を返します。外部の決済やメール送信は、そのDBトランザクションだけでは一度の実行を保証できません。外部サービスの冪等性キーや、永続アウトボックスなどを別に検討します。',
    '3\n00:00:41,000 --> 00:01:00,000\n検証では、同じキーの逐次要求だけでなく同時要求も試します。コミット後に応答が失われ、同じキーで再試行された場合も検証します。副作用が重複せず、保存済みの同じ結果を返すことを確かめます。教材で定めていない待ち時間や試行回数を勝手に一般則として追加しないでください。',
  ].join('\n\n');
  const sql = async (query: string, args: (string | number)[] = []) => { await fixture.database.prepare(query).bind(...args).run(); };
  const started = Date.now();
  let report: Record<string, unknown> = { model: env.LLM_MODEL, maxTokens: env.LLM_MAX_TOKENS, source: 'synthetic-retry-lecture-v1', evaluation: 'generation-pilot-only', effectComparisonCompleted: false };
  try {
    await sql("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,ai_answers_limit) VALUES('pilot','pilot','pilot@example.test',0,0,0,0,12)");
    await sql("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(1,'pilot','Retry lecture','synthetic.mp4','completed',?,'','2026-11-27','','uploaded','','')", [lecture]);
    await sql("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(1,'pilot','Skill generation pilot','','2026-11-27','2026-11-27',0)");
    await sql('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(1,1,?,0)', ['2026-11-27']);
    const owner = courseSkillManagement(env, 'pilot');
    await owner.configure(1, { generationEnabled: true, distributionEnabled: false, language: 'ja', policyVersion: '1' });
    for (let tick = 0; tick < 16; tick++) {
      await executeNextCourseSkillBuild(env);
      const state = await owner.list(1);
      console.info(JSON.stringify({ tick, state: state.jobs[0]?.state, phase: state.jobs[0]?.phase, candidates: state.candidates.length }));
      if (['completed', 'failed'].includes(state.jobs[0]?.state)) break;
      await sql('UPDATE course_skill_builds SET lease_until=0');
    }
    const state = await owner.list(1);
    report = { ...report, elapsedMs: Date.now() - started, state, details: await Promise.all(state.candidates.map(c => owner.get(1, c.id))),
      knowledge: (await fixture.database.prepare('SELECT key,content FROM course_skill_knowledge_chunks').all()).results.map(row => ({ key: row.key, content: JSON.parse(String(row.content)) as unknown })),
      candidates: (await fixture.database.prepare('SELECT content FROM course_skill_candidates').all()).results.map(row => JSON.parse(String(row.content)) as unknown),
      quota: await fixture.database.prepare("SELECT used_ai_answers FROM users WHERE id='pilot'").first(),
      ledger: (await fixture.database.prepare('SELECT status,quota_consumed,provider_calls FROM ai_answer_attempts').all()).results };
  } catch {
    report = { ...report, elapsedMs: Date.now() - started, error: 'PILOT_EXECUTION_FAILED' };
  } finally {
    report.requests = requests;
    globalThis.fetch = originalFetch;
    await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await fixture.dispose();
  }
}
