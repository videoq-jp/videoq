import { seedPostgresSceneIndex } from "./helpers/postgres-scene-index";
import { once } from "node:events";
import type { Server } from "node:http";
import pg from "pg";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../scripts/migrate-database";
import { nodeBindings } from "../src/runtime/node-config";
import { createNodeApp } from "../src/runtime/node-app";
import { postgresRateLimitBackend } from "../src/runtime/postgres-rate-limit";
import { withAuth } from "../src/persistence/auth";
import { connectEvidenceMcp } from "../src/integrations/evidence-mcp";
import type { Bindings } from "../src/types/bindings";
import { courseSkillManagement } from '../src/integrations/course-skill-management';
import { executeNextCourseSkillBuild } from '../src/integrations/course-skill-execution';
import { MODERN_MCP_VERSION } from '../src/features/mcp/modern-http';

// Real sockets, API-key verification, PostgreSQL, pgvector, quotas and S3 reads.
// Only AI and object-storage responses are deterministic local HTTP fixtures.
const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const withPostgres = databaseUrl ? describe : describe.skip;
const embedding = Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0);
const transcript = "1\n00:00:00,000 --> 00:00:05,000\nA red line rises on the graph.";

async function listen(fetch: (request: Request) => Response | Promise<Response>) {
  const server = serve({ fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
async function stop(server?: Server) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

withPostgres("external HTTP MCP with real authentication and PostgreSQL", () => {
  const databaseName = `mcp_http_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let db: pg.Client;
  let pool: pg.Pool;
  let env: Bindings;
  let origin: string;
  let apiServer: Server;
  let providerServer: Server;
  let app: ReturnType<typeof createNodeApp>;
  let key: string;
  let embeddings = 0;
  let inspections = 0;
  let skillGenerations = 0;
  let databaseCreated = false;
  const clients: Client[] = [];

  async function external(apiKey = key) {
    const client = new Client({ name: "independent-http-client", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
      requestInit: { headers: { "X-API-Key": apiKey } },
    }));
    await client.listTools();
    return client;
  }
  const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await migrateDatabase(db, { writersStopped: true });
    await db.query(`INSERT INTO users (id,name,email,username,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
      VALUES ('owner','Owner','owner@example.invalid','owner',false,0,0,0),('member','Member','member@example.invalid','member',false,0,0,0);
      INSERT INTO videos (id,user_id,title,description,file,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
      VALUES (42,'owner','Graph lesson','','private/lesson.mp4',now(),'${transcript}','completed','','uploaded','',''),
             (99,'owner','Other course lesson','','private/other.mp4',now(),'Private transcript','completed','','uploaded','','');
      INSERT INTO video_courses (id,user_id,name,description,created_at,updated_at,display_order)
      VALUES (3,'owner','Graph course','Graph description',now(),now(),0),(4,'owner','Private course','',now(),now(),0);
      INSERT INTO video_course_members (course_id,video_id,"order",added_at) VALUES (3,42,0,now()),(4,99,0,now());
      INSERT INTO video_course_memberships (course_id,user_id,joined_at) VALUES (3,'member',now());`);
    await seedPostgresSceneIndex(url.toString(), 42, [{ text: "A red line rises on the graph.", vector: embedding, endTime: "00:00:05" }]);
    await seedPostgresSceneIndex(url.toString(), 99, [{ text: "Private scene", vector: embedding, endTime: "00:00:05" }]);
    const provider = new Hono();
    provider.post("/v1/embeddings", async c => {
      const body = await c.req.json();
      expect(body.dimensions).toBe(1536);
      embeddings++;
      return c.json({ data: [{ index: 0, embedding }], usage: { prompt_tokens: 3, total_tokens: 3 } });
    });
    provider.post("/v1/chat/completions", async c => {
      const body = await c.req.json();
      const name = body.response_format?.json_schema?.name as string | undefined;
      if (name && ['course_knowledge', 'skill_task_plan', 'skill_draft', 'skill_draft_audit'].includes(name)) {
        // Fixed provider responses exercise the real model adapter and quota
        // ledger; this is a transport/authentication test, not semantic evidence.
        const input = JSON.parse(body.messages.at(-1).content) as { cues: { id: string }[]; facts: { id: string; kind: string }[]; existing: { skillId: string }[]; task: { slug: string } };
        let result: unknown;
        switch (name) {
          case 'course_knowledge': result = { facts: ['principle', 'procedure', 'verification'].map(kind => ({ kind, claim: 'A red line rises on the graph.', appliesWhen: [], exceptions: [], evidence: [{ cueId: input.cues[0].id }], requiresVisualEvidence: false, versionContext: { language: '', framework: '', version: '' } })), verificationFacts: [] }; break;
          case 'skill_task_plan': result = { proposals: [{ existingSkillId: input.existing[0]?.skillId ?? null, slug: 'inspect-graph', objective: 'Inspect graph evidence', criterionFactIds: input.facts.filter(f => f.kind === 'principle').map(f => f.id), procedureFactIds: input.facts.filter(f => f.kind === 'procedure').map(f => f.id), verificationFactIds: input.facts.filter(f => f.kind === 'verification').map(f => f.id), additionalFactIds: [] }], issues: [] }; break;
          case 'skill_draft': result = { slug: input.task.slug, title: 'Inspect graph', description: 'Inspect the graph evidence.', useWhen: ['Inspecting the graph'], doNotUseWhen: [], criteria: [{ decision: 'A red line rises on the graph.', factIds: [input.facts[0].id] }], steps: [{ action: 'A red line rises on the graph.', expectedResult: 'Graph evidence is available', factIds: [input.facts[1].id] }], exceptions: [], checks: [{ check: 'A red line rises on the graph.', factIds: [input.facts[2].id] }], examples: [] }; break;
          default: result = { supported: true, issues: [] };
        }
        skillGenerations++;
        return c.json({ id: 'skill-provider-fixture', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      }
      expect(JSON.stringify(body.messages)).toContain("data:image/jpeg;base64,");
      inspections++;
      return c.json({ id: "fixture", object: "chat.completion", created: 1, model: "fixture-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ observations: [{ frame_index: 1, observation: "The red line rises." }] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    });
    provider.get("*", c => c.req.path.endsWith("lesson.mp4.frames-v1.json")
      ? c.json({ version: 1, video_id: 42, duration_seconds: 10, sampling_interval_seconds: 5,
        frames: [{ timestamp_seconds: 0, jpeg_base64: "/9j/2Q==" }, { timestamp_seconds: 5, jpeg_base64: "/9j/2Q==" }] })
      : c.notFound());
    const providerHttp = await listen(request => provider.fetch(request));
    providerServer = providerHttp.server;
    pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
    env = nodeBindings({ DATABASE_URL: url.toString(), BETTER_AUTH_URL: "http://127.0.0.1", BETTER_AUTH_SECRET: "s".repeat(48),
      USER_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"), R2_ACCESS_KEY_ID: "fixture", R2_SECRET_ACCESS_KEY: "fixture",
      R2_S3_ENDPOINT: providerHttp.origin, R2_BUCKET_NAME: "fixture", SQS_QUEUE_URL: "http://127.0.0.1:9/unused",
      AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture", OPENAI_BASE_URL: `${providerHttp.origin}/v1`,
      OPENAI_API_KEY: "fixture", EMBEDDING_BASE_URL: `${providerHttp.origin}/v1`, EMBEDDING_API_KEY: "fixture", LLM_MODEL: "fixture-model" });
    env.DATABASE_POOL = pool;
    env.RATE_LIMIT_BACKEND = postgresRateLimitBackend(pool);
    app = createNodeApp(env);
    const apiHttp = await listen(request => app.fetch(request));
    apiServer = apiHttp.server;
    origin = apiHttp.origin;
    env.BETTER_AUTH_URL = origin;
    env.OAUTH_ISSUER_URL = origin;
    env.FRONTEND_URL = origin;
  }, 60_000);

  beforeEach(async () => {
    key = (await withAuth(env, auth => auth.api.createApiKey({ body: { userId: "member" } }))).key;
  });

  afterAll(async () => {
    await Promise.all(clients.map(client => client.close()));
    await stop(apiServer);
    await app?.drain();
    await stop(providerServer);
    await pool?.end();
    await db?.end();
    if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end();
  });

  it("rejects missing or invalid credentials through the HTTP boundary", async () => {
    const response = await fetch(`${origin}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "unauthenticated", version: "1" } } }) });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    await expect(external("vq_invalid_fixture_key")).rejects.toThrow();
  });

  it("discovers all tools and runs search → subtitles → visual inspection without an agent", async () => {
    const client = await external();
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(22);
    expect(tools.some(tool => tool.name === "get_skill")).toBe(false);
    const scenes = await call(client, "search_scenes", { course_id: 3, query: "red graph", video_ids: null });
    expect(scenes.structuredContent).toMatchObject({ result: { scenes: [{ videoId: 42, text: "A red line rises on the graph." }] } });
    const subtitles = await call(client, "read_video_window", { course_id: 3, video_id: 42, start_seconds: 0, end_seconds: 5, context_seconds: 0 });
    expect(subtitles.structuredContent).toMatchObject({ result: { scenes: [{ videoId: 42, text: "A red line rises on the graph." }] } });
    const images = await call(client, "inspect_clip", { course_id: 3, video_id: 42, start_seconds: 0, end_seconds: 5, query: "red graph" });
    expect(images.structuredContent).toMatchObject({ result: { observations: [{ text: "The red line rises.", evidenceType: "visual" }] } });
    expect(embeddings).toBe(1);
    expect(inspections).toBe(1);
    expect(JSON.stringify([scenes, subtitles, images])).not.toMatch(/private\/|sourceId|ownerUserId|fixture_key/);
  });

  it("matches internal evidence for the same authorized course and question", async () => {
    const client = await external();
    const internal = await connectEvidenceMcp(env, { ownerUserId: "owner", courseId: 3, videoIds: [42] }, new AbortController().signal);
    try {
      for (const [name, args] of [
        ["search_scenes", { query: "red graph", video_ids: null }],
        ["read_video_window", { video_id: 42, start_seconds: 0, end_seconds: 5, context_seconds: 0 }],
        ["inspect_clip", { video_id: 42, start_seconds: 0, end_seconds: 5, query: "red graph" }],
        ["get_course_info", { video_limit: 20, video_offset: 0 }],
      ] as const) {
        const externalResult = await call(client, name, { course_id: 3, ...args });
        const internalResult = await call(internal.client, name, args);
        expect(externalResult.isError).not.toBe(true);
        expect(externalResult.structuredContent).toEqual(internalResult.structuredContent);
      }
    } finally { await internal.close(); }
  });

  it("denies unauthorized courses, videos, injected scope and write operations", async () => {
    const client = await external();
    const previous = { embeddings, inspections };
    const args = { video_id: 42, start_seconds: 0, end_seconds: 5, context_seconds: 0 };
    expect((await call(client, "read_video_window", { course_id: 4, ...args })).structuredContent).toMatchObject({ result: { status: "unavailable" } });
    expect(JSON.stringify(await call(client, "read_video_window", { course_id: 3, ...args, video_id: 99 }))).toContain("Invalid video_id");
    expect((await call(client, "read_video_window", { course_id: 3, ...args, ownerUserId: "owner" })).isError).toBe(true);
    const denied = await call(client, "create_course", { name: "Unauthorized", idempotency_key: "mcp-http-denied" });
    expect(denied).toMatchObject({ isError: true, structuredContent: { status: 403, code: "FORBIDDEN" } });
    expect({ embeddings, inspections }).toEqual(previous);
    expect((await db.query("SELECT count(*)::int AS count FROM video_courses")).rows[0].count).toBe(2);
  });

  it("persists paid usage without storing prompts, images, or credentials", async () => {
    const { rows } = await db.query("SELECT status, quota_consumed, provider_calls FROM ai_answer_attempts");
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.status === "completed" && row.quota_consumed)).toBe(true);
    expect(rows.flatMap(row => row.provider_calls)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "query_embedding", status: "completed", usage: { prompt_tokens: 3, total_tokens: 3 } }),
      expect.objectContaining({ kind: "visual_inspection", status: "completed", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    ]));
    expect(JSON.stringify(rows)).not.toMatch(/private\/|red graph|data:image|vq_/);
  });

  it("keeps evidence limits across separate authenticated HTTP clients", async () => {
    const backend = env.RATE_LIMIT_BACKEND!;
    const counter = "throttle_mcp_evidence_user_member";
    const count = (await backend.snapshot(counter))?.count ?? 0;
    expect((await backend.consume(counter, 240, 3600, 240 - count)).allowed).toBe(true);
    const previous = embeddings;
    for (let i = 0; i < 2; i++) {
      const result = await call(await external(), "search_scenes", { course_id: 3, query: "red graph", video_ids: null });
      expect(result.structuredContent).toMatchObject({ result: { status: "rate_limited" } });
    }
    expect(embeddings).toBe(previous);
  });


  it("observes the API-key request cap separately from MCP execution limits", async () => {
    const defaults = (await db.query("SELECT rate_limit_max, rate_limit_time_window FROM apikey WHERE reference_id = 'member' ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(defaults).toMatchObject({ rate_limit_max: 1200, rate_limit_time_window: 3_600_000 });
    // Use a small explicit cap to keep this probe bounded after policy changes.
    const limitedKey = await withAuth(env, auth => auth.api.createApiKey({ body: { userId: "member", rateLimitMax: 3, rateLimitTimeWindow: 60_000 } }));
    const statuses: number[] = [];
    let lastBody: unknown;
    let retryAfter: string | null = null;
    for (let i = 0; i <= 3; i++) {
      const response = await fetch(`${origin}/api/mcp`, { method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": limitedKey.key, accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }) });
      statuses.push(response.status);
      retryAfter = response.headers.get("retry-after");
      if (response.status === 429) expect(response.headers.get("www-authenticate")).toBeNull();
      lastBody = await response.json();
    }
    expect(statuses.slice(0, -1).every(status => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(lastBody).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    console.info(JSON.stringify({ event: "mcp_api_key_limit_observation", defaultKeyPolicy: defaults, probe: { maxRequests: 3, windowMs: 60_000, statuses, error: lastBody } }));
  });

  it('generates, reviews and publishes through runtime factories, then enforces live Skill fences over authenticated HTTP', async () => {
    const scheduler = env.TASK_SCHEDULER;
    env.TASK_SCHEDULER = { getByName: () => ({ armAt: async () => undefined }) } as unknown as Bindings['TASK_SCHEDULER'];
    try {
      const owner = courseSkillManagement(env, 'owner');
      await expect(courseSkillManagement(env, 'member').configure(3, { generationEnabled: true, distributionEnabled: true, language: 'en', policyVersion: '1' })).rejects.toMatchObject({ kind: 'not_found' });
      await owner.configure(3, { generationEnabled: true, distributionEnabled: true, language: 'en', policyVersion: '1' });
      let finished = false;
      for (let tick = 0; tick < 12; tick++) {
        const before = skillGenerations;
        await executeNextCourseSkillBuild(env);
        expect(skillGenerations - before).toBeLessThanOrEqual(1);
        const state = await owner.list(3);
        expect(state.jobs[0].state).not.toBe('failed');
        if (state.jobs[0].state === 'completed') { finished = true; break; }
        await db.query('UPDATE course_skill_builds SET lease_until=0 WHERE course_id=3');
      }
      expect(finished).toBe(true);
      expect(skillGenerations).toBe(4);
      const state = await owner.list(3), candidate = await owner.get(3, state.candidates[0].id);
      await owner.update(3, candidate.id, candidate.contentHash, { ...candidate.draft!, title: 'Owner-reviewed graph guide' });
      const reviewed = await owner.get(3, candidate.id);
      await owner.publish(3, reviewed.id, reviewed.contentHash);
      expect(skillGenerations).toBe(5);

      const client = await external();
      const listed = await call(client, 'list_course_skills', {});
      const result = listed.structuredContent as { result: { skills: { uri: string; resources: { uri: string }[] }[] } };
      expect(result.result.skills).toHaveLength(1);
      const entry = result.result.skills[0], reference = entry.resources.find(r => r.uri.endsWith('/references/sources.md'))!.uri;
      expect(await call(client, 'get_course_skill', { uri: entry.uri })).toMatchObject({ structuredContent: { result: { skill: { uri: entry.uri } } } });
      expect(await call(client, 'read_course_skill_resource', { uri: entry.uri })).toMatchObject({ structuredContent: { result: { contents: [{ text: expect.stringContaining('Owner-reviewed graph guide') }] } } });

      async function modern(method: string, uri?: string) {
        const response = await fetch(`${origin}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'MCP-Protocol-Version': MODERN_MCP_VERSION, 'Mcp-Method': method, ...(uri ? { 'Mcp-Name': uri } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...(uri ? { uri } : {}), _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_MCP_VERSION, 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/skills': {} } } } } }) });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        return response.json();
      }
      expect(await modern('skills/get', entry.uri)).toMatchObject({ result: { skill: { uri: entry.uri } } });
      expect(await modern('resources/read', reference)).toMatchObject({ result: { contents: [{ text: expect.stringContaining('A red line rises') }] } });

      // Opt-in real-client check. CI and ordinary integration tests never invoke
      // a paid model. The independently logged-in client receives only a fresh
      // local read-only API key, never the database/provider credentials.
      if (process.env.VIDEOQ_CODEX_HTTP_COMPATIBILITY === '1') {
        const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { runCodexTrial, codexVersion } = await import('../scripts/course-skill-evaluation/codex');
        const workspace = await mkdtemp(join(tmpdir(), 'videoq-codex-app-http-'));
        try {
          const clientVersion = await codexVersion();
          const execution = await runCodexTrial({ workspace, model: process.env.VIDEOQ_CODEX_HTTP_MODEL ?? 'gpt-6.1-terra', timeoutMs: 120000,
            server: { url: `${origin}/api/mcp`, bearer: key, allowedTools: ['list_course_skills', 'get_course_skill', 'read_course_skill_resource'] },
            prompt: `これは合成教材の実アプリHTTP認証・取得確認です。get_course_skillで ${entry.uri} のmanifestを取得し、read_course_skill_resourceで同じURIの本文と ${reference} の参照資料を読んでください。取得した出典の動画IDと時刻を短く回答してください。コード変更・検索・外部Webは不要です。` });
          const calls = execution.events.flatMap(event => {
            const item = (event as { item?: { type?: string; tool?: string; status?: string; error?: unknown; arguments?: { uri?: string }; result?: { isError?: boolean } } }).item;
            return event.type === 'item.completed' && item?.type === 'mcp_tool_call' ? [{ name: item.tool, uri: item.arguments?.uri, success: item.status === 'completed' && !item.error && Boolean(item.result) && item.result?.isError !== true }] : [];
          });
          const ready = execution.completed && calls.some(call => call.name === 'get_course_skill' && call.uri === entry.uri && call.success)
            && [entry.uri, reference].every(uri => calls.some(call => call.name === 'read_course_skill_resource' && call.uri === uri && call.success));
          expect(await codexVersion()).toBe(clientVersion);
          await writeFile(process.env.VIDEOQ_CODEX_HTTP_EVIDENCE ?? join(tmpdir(), 'videoq-authenticated-skill-http-codex.json'), JSON.stringify({ ready, clientVersion, execution, calls,
            authenticatedApplicationRoute: true, fixedLocalModelProvider: true, effectTrial: false, productionWrites: 0 }, null, 2), { mode: 0o600, flag: 'wx' });
          expect(ready).toBe(true);
        } finally { await rm(workspace, { recursive: true, force: true }); }
      }

      await db.query("DELETE FROM video_course_memberships WHERE course_id=3 AND user_id='member'");
      expect(await call(client, 'list_course_skills', {})).toMatchObject({ structuredContent: { result: { skills: [] } } });
      expect(await modern('resources/read', entry.uri)).toMatchObject({ error: { code: -32602 } });
      await db.query("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES(3,'member',now())");
      expect(await modern('skills/get', entry.uri)).toMatchObject({ result: { skill: { uri: entry.uri } } });

      await db.query('DELETE FROM video_course_members WHERE course_id=3 AND video_id=42');
      expect(await modern('skills/list')).toMatchObject({ result: { skills: [] } });
      for (const uri of [entry.uri, reference]) {
        expect(await call(client, 'read_course_skill_resource', { uri })).toMatchObject({ isError: true, structuredContent: { code: 'SKILL_UNAVAILABLE' } });
        expect(await modern('resources/read', uri)).toMatchObject({ error: { code: -32602 } });
      }
      await db.query('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES(3,42,0,now())');
      expect(await modern('skills/get', entry.uri)).toMatchObject({ error: { code: -32602 } });
      expect(await modern('resources/read', reference)).toMatchObject({ error: { code: -32602 } });
      expect(skillGenerations).toBe(5);
    } finally { env.TASK_SCHEDULER = scheduler; }
  }, process.env.VIDEOQ_CODEX_HTTP_COMPATIBILITY === '1' ? 180000 : 60000);

});
