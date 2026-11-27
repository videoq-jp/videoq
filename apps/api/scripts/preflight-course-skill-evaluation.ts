/** Opt-in real search/client preflight; this does not execute or score the effect benchmark. */
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { readFrozenCourse, readOnlySearchTransport, createFrozenEvaluationEnvironment } from './course-skill-evaluation/environment';
import { startEvaluationMcp } from './course-skill-evaluation/mcp-server';
import { runCodexTrial } from './course-skill-evaluation/codex';
import { evaluationCases } from './course-skill-evaluation/cases';
import { validateReferenceCases } from './course-skill-evaluation/fixtures';

const { values } = parseArgs({ options: {
  run: { type: 'boolean' }, codex: { type: 'boolean' }, 'validate-fixtures': { type: 'boolean' },
  'course-id': { type: 'string' }, 'account-id': { type: 'string' }, 'index-name': { type: 'string' },
  'videos-file': { type: 'string' }, 'runs-file': { type: 'string' }, 'scenes-file': { type: 'string' },
  'source-file': { type: 'string' }, 'wrangler-auth-file': { type: 'string' }, output: { type: 'string' }, model: { type: 'string' },
} });
try {
  if (values['validate-fixtures']) {
    const checked = await validateReferenceCases(evaluationCases);
    console.info(JSON.stringify({ cases: evaluationCases.length, codeContractsValidated: checked.length, modelCalls: 0 }));
  } else if (!values.run) {
    console.info('Use --validate-fixtures for offline checks. Live preflight requires --run --course-id --account-id --index-name --videos-file --runs-file --scenes-file --source-file --wrangler-auth-file --output. Files are private frozen D1 snapshots; source-file is the original bounded transcript input. --codex additionally invokes the actual logged-in Codex client, with --model (default gpt-6.1-terra). Search uses at most four embedding/vector requests. No course data or index writes; no Skill publication or effect-comparison result.');
  } else {
    const courseId = Number(values['course-id']);
    if (!Number.isSafeInteger(courseId) || courseId <= 0 || !values['account-id'] || !values['index-name'] || !values['videos-file'] || !values['runs-file'] || !values['scenes-file'] || !values['source-file'] || !values['wrangler-auth-file'] || !values.output) throw new Error('PREFLIGHT_ARGUMENTS_REQUIRED');
    if (await stat(values.output).then(() => true, () => false)) throw new Error('PREFLIGHT_OUTPUT_EXISTS');
    const output = values.output, authFile = values['wrangler-auth-file'];
    const source = await readFrozenCourse({ courseId, videos: values['videos-file'], runs: values['runs-file'], scenes: values['scenes-file'], originalInput: values['source-file'] });
    const transport = readOnlySearchTransport({ accountId: values['account-id'], indexName: values['index-name'], ownerId: source.videos[0].user_id, videoIds: source.videos.map(v => v.id), maxCalls: 4,
      token: async () => { const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(await readFile(authFile, 'utf8'))?.[1]; if (!token) throw new Error('PREFLIGHT_AUTH_UNAVAILABLE'); return token; },
    });
    const fixture = await createFrozenEvaluationEnvironment(source, transport);
    const client = new Client({ name: 'videoq-evaluation-preflight', version: '1' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    let server: Awaited<ReturnType<typeof startEvaluationMcp>> | undefined;
    let report: Record<string, unknown> = { courseId, videoIds: source.videos.map(v => v.id), scenes: source.scenes.length, productionWrites: false, published: false, effectComparisonCompleted: false };
    try {
      server = await startEvaluationMcp({ env: fixture.env, ownerId: fixture.ownerId, courseId, mode: 'search', maxToolCalls: 8 });
      const unauthenticated = await fetch(server.url, { method: 'POST' });
      if (unauthenticated.status !== 401) throw new Error('PREFLIGHT_AUTH_FENCE_FAILED');
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.bearer}` } } }));
      const tools = (await client.listTools()).tools.map(t => t.name).sort();
      if (tools.join(',') !== 'get_course_info,read_video_window,search_scenes') throw new Error('PREFLIGHT_TOOL_SCOPE_FAILED');
      const denied = await client.callTool({ name: 'search_scenes', arguments: { course_id: courseId + 1, query: 'test scope', video_ids: null } });
      if (!denied.isError || fixture.stats.embeddingCalls || fixture.stats.vectorQueries) throw new Error('PREFLIGHT_COURSE_FENCE_FAILED');
      const result = await client.callTool({ name: 'search_scenes', arguments: { course_id: courseId, query: 'ランダムな処理を固定値を返す関数に差し替えてテストする方法', video_ids: null } });
      const structured = result.structuredContent as { result?: { scenes?: { videoId: number }[] } } | undefined;
      const found = structured?.result;
      if (result.isError || !Array.isArray(found?.scenes) || !found.scenes.length || found.scenes.some(hit => !source.videos.some(v => v.id === hit.videoId))) throw new Error('PREFLIGHT_SEARCH_FAILED');
      report = { ...report, tools, unauthenticatedStatus: 401, foreignCourseDenied: true, result };
      if (values.codex) {
        const workspace = await mkdtemp(join(tmpdir(), 'videoq-codex-search-preflight-'));
        const before = server.calls.length;
        const outcome = await runCodexTrial({ workspace, model: values.model ?? 'gpt-6.1-terra', timeoutMs: 120_000, server,
          prompt: `これは接続確認のみです。講座${courseId}のランダム処理を固定値に差し替えてテストする説明をsearch_scenesで1回だけ検索し、取得した出典の動画IDと時刻を短く回答してください。コード実装・ファイル変更・Web検索は不要です。`,
        });
        report.codex = outcome;
        if (!outcome.completed || !server.calls.slice(before).some(c => c.name === 'search_scenes' && c.success)) throw new Error('PREFLIGHT_CODEX_FAILED');
      }
      report.ready = true;
    } catch { report.ready = false; report.error = 'PREFLIGHT_EXECUTION_FAILED'; process.exitCode = 1; }
    finally {
      try { await writeFile(output, JSON.stringify({ ...report, stats: fixture.stats, calls: server?.calls }, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
      finally { await client.close(); await server?.close(); await fixture.dispose(); }
    }
    console.info(JSON.stringify({ ready: report.ready, effectComparisonCompleted: false, stats: fixture.stats }));
  }
} catch { console.error('Evaluation preflight failed. Check private inputs and the existing authentication; no credentials or course text are logged.'); process.exitCode = 1; }
