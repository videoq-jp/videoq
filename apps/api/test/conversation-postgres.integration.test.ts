import pg from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { plainChatAnswer, chatAnswerText } from '@videoq/trpc/chat';
import { openConversation, pruneConversations, ConversationBusyError, ConversationNotFoundError } from '../src/repositories/conversation-repository';
import { listConversations, getConversation, deleteConversation, conversationScope } from '../src/features/chat/conversation-service';
import { setupConversationCheckpoints } from '../scripts/migrations/conversation/setup';
import { createChatLogWithDb } from '../src/repositories/chat-repository';
import { runRag, type RagResult } from '../src/lib/rag';
import { chatCompletionResponse } from './helpers/chat-completion-response';
import { requestBodyText } from './helpers/request-body';
import * as vectors from '../src/repositories/vector-repository';
import { runChatRag, streamChatRag } from '../src/lib/conversation-execution';
import type { Bindings } from '../src/types/bindings';

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('conversation checkpoints on PostgreSQL', () => {
  const database = `videoq_conversations_${crypto.randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let env: Bindings;
  const createdRoles: string[] = [];
  const scope = { ownerUserId: 'owner', actorUserId: 'alice', courseId: 1, shareSlug: null };
  const respond = (_messages: BaseMessage[], question: string) => Promise.resolve({
    queryText: question, answer: plainChatAnswer('answer'), retrievedContexts: [],
  });
  const invoke = async (chat: Awaited<ReturnType<typeof openConversation>>, question: string,
    answer: (messages: BaseMessage[], question: string) => Promise<RagResult> = respond) => {
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(requestBodyText(init.body));
      const messages = body.messages.filter((message: { role: string }) => ['user', 'assistant'].includes(message.role))
        .map((message: { role: string; content: string }) => message.role === 'user' ? new HumanMessage(message.content)
          : new AIMessage(chatAnswerText({ ...JSON.parse(message.content), sources: [] })));
      const content = body.response_format ? JSON.stringify({ segments: (await answer(messages, question)).answer.segments })
        : 'The conversation is about perpendicular vectors.';
      return chatCompletionResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }, !!body.stream, crypto.randomUUID());
    });
    return runRag({ ...env, OPENAI_API_KEY: 'test', OPENAI_BASE_URL: 'https://model.test/v1' }, {
      ownerUserId: 'owner', videoIds: null, locale: 'en', messages: [{ role: 'user', content: question }], memory: chat,
    });
  };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    admin.on('error', () => {});
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    pool.on('error', () => {});
    env = { DATABASE_POOL: pool } as Bindings;
    await pool.query(`CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE video_courses(id bigint PRIMARY KEY, user_id text, share_slug text);
      CREATE TABLE video_course_members(id bigint, course_id bigint, video_id bigint, "order" int);
      CREATE TABLE video_course_memberships(course_id bigint, user_id text);
      CREATE TABLE chat_logs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, course_id bigint, user_id text,
        question text, response jsonb, retrieved_contexts jsonb, feedback text, is_shared_origin boolean, created_at timestamptz)`);
    await pool.query(readFileSync(new URL('../drizzle/0043_chat_conversation_memory.sql', import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''));
    await pool.query(readFileSync(new URL('../drizzle/0044_resumable_conversations.sql', import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''));
    for (const role of ['videoq_api_access', 'videoq_backup_access']) {
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
        await admin.query(`CREATE ROLE ${role} NOLOGIN`); createdRoles.push(role);
      }
    }
    await setupConversationCheckpoints(pool);
    await setupConversationCheckpoints(pool);
    await pool.query("INSERT INTO users VALUES ('owner'), ('alice'), ('bob'); INSERT INTO video_courses VALUES (1, 'owner', 'shared'), (2, 'owner', null); INSERT INTO video_course_memberships VALUES (1, 'alice')");
  });
  afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await pool?.query('DELETE FROM chat_conversations; DELETE FROM chat_logs'); });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      for (const role of createdRoles) await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  });

  it('allows the restricted API role to checkpoint and the backup role to read without runtime DDL', async () => {
    const restrictedPool = new pg.Pool({ connectionString: pool.options.connectionString, options: '-c role=videoq_api_access', max: 2 });
    const chat = await openConversation({ ...env, DATABASE_POOL: restrictedPool }, scope, crypto.randomUUID());
    const client = await pool.connect();
    try {
      await client.query('SET ROLE videoq_api_access');
      expect((await client.query("SELECT has_schema_privilege(current_user, 'chat_memory', 'CREATE') AS allowed")).rows[0].allowed).toBe(false);
      await chat.commit(await invoke(chat, 'Restricted API question'));
      expect(await chat.saver.get({ configurable: { thread_id: chat.threadId } })).toBeDefined();
      await client.query('RESET ROLE');
      await client.query('SET ROLE videoq_backup_access');
      expect((await client.query('SELECT count(*)::int AS count FROM chat_memory.checkpoints')).rows[0].count).toBeGreaterThan(0);
      expect((await client.query("SELECT has_table_privilege(current_user, 'chat_memory.checkpoints', 'INSERT') AS allowed")).rows[0].allowed).toBe(false);
      await client.query('SELECT * FROM chat_memory.checkpoint_migrations');
    } finally {
      await client.query('RESET ROLE'); client.release(); await chat.close(); await restrictedPool.end();
    }
  });

  it('restores typed messages through a fresh saver and never commits a failed turn', async () => {
    const id = crypto.randomUUID();
    let chat = await openConversation(env, scope, id);
    await chat.commit(await invoke(chat, 'first', respond));
    await chat.close();
    chat = await openConversation(env, scope, id);
    await expect(invoke(chat, 'failed', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await chat.close();
    chat = await openConversation(env, scope, id);
    const seen: string[][] = [];
    await chat.commit(await invoke(chat, 'follow-up', (messages, question) => {
      seen.push(messages.map(message => message.text));
      return respond(messages, question);
    }));
    await chat.close();
    expect(seen).toEqual([['first', 'answer', 'follow-up']]);
    expect((await pool.query('SELECT count(*)::int AS count FROM chat_memory.checkpoints')).rows[0].count).toBeGreaterThan(0);
  });

  it('rejects concurrent writes and keeps actors and share visitors isolated', async () => {
    const id = crypto.randomUUID();
    const a = await openConversation(env, scope, id);
    await expect(openConversation(env, scope, id)).rejects.toBeInstanceOf(ConversationBusyError);
    const b = await openConversation(env, { ...scope, actorUserId: 'bob' }, id);
    const share = await openConversation(env, { ...scope, actorUserId: null, shareSlug: 'share', visitorSessionId: 'visitor-a' }, id);
    const otherVisitor = await openConversation(env, { ...scope, actorUserId: null, shareSlug: 'share', visitorSessionId: 'visitor-b' }, id);
    expect(new Set([a.threadId, b.threadId, share.threadId, otherVisitor.threadId]).size).toBe(4);
    await Promise.all([a.close(), b.close(), share.close(), otherVisitor.close()]);
    const reopened = await openConversation(env, scope, id);
    await reopened.close();
  });

  it('removes actor-owned conversation state when that account is deleted', async () => {
    await pool.query("INSERT INTO users VALUES ('temporary-actor')");
    const chat = await openConversation(env, { ...scope, actorUserId: 'temporary-actor' }, crypto.randomUUID());
    await chat.commit(await invoke(chat, 'private question', respond));
    await chat.close();
    await pool.query("DELETE FROM users WHERE id = 'temporary-actor'");
    expect((await pool.query('SELECT count(*)::int AS count FROM chat_memory.checkpoints')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM chat_memory.checkpoint_blobs')).rows[0].count).toBe(0);
  });

  it('deletes checkpoint payloads with expired conversations and deleted courses', async () => {
    const chat = await openConversation(env, scope, crypto.randomUUID());
    await chat.commit(await invoke(chat, 'first', respond));
    await chat.close();
    await pool.query("UPDATE chat_conversations SET expires_at = now() - interval '1 second'");
    expect(await pruneConversations(env)).toBe(1);
    for (const table of ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes']) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM chat_memory.${table}`)).rows[0].count).toBe(0);
    }
    const next = await openConversation(env, { ...scope, courseId: 2 }, crypto.randomUUID());
    await next.commit(await invoke(next, 'next', respond));
    await next.close();
    await pool.query('DELETE FROM video_courses WHERE id = 2');
    expect((await pool.query('SELECT count(*)::int AS count FROM chat_memory.checkpoints')).rows[0].count).toBe(0);
  });

  it('uses default async durability with stock checkpoint history and preserves the full transcript', async () => {
    const id = crypto.randomUUID();
    for (let i = 0; i < 16; i++) {
      const chat = await openConversation(env, scope, id);
      await chat.commit(await invoke(chat, `Question ${i}`, respond));
      await chat.close();
      const counts = await pool.query(`SELECT (SELECT count(*)::int FROM chat_memory.checkpoints) AS checkpoints,
        (SELECT count(*)::int FROM chat_memory.checkpoint_blobs) AS blobs`);
      expect(counts.rows[0].checkpoints).toBeGreaterThan((i + 1) * 2);
      expect(counts.rows[0].blobs).toBeGreaterThan(0);
    }
    const detail = await getConversation(env, scope, { conversationId: id, limit: 10 });
    expect(detail.title).toBe('Question 0');
    expect(detail.turns.map(turn => turn.question)).toEqual(Array.from({ length: 10 }, (_, i) => `Question ${i + 6}`));
    expect(detail.hasMore).toBe(true);
    const older = await getConversation(env, scope, { conversationId: id, limit: 10, beforeTurnId: detail.turns[0].id });
    expect(older.turns.map(turn => turn.question)).toEqual(Array.from({ length: 6 }, (_, i) => `Question ${i}`));
    expect(older.hasMore).toBe(false);
    const chat = await openConversation(env, scope, id);
    let context: string[] = [];
    await chat.commit(await invoke(chat, 'Still remember?', (messages, question) => {
      context = messages.map(message => message.text); return respond(messages, question);
    }));
    await chat.close();
    expect(context).toContain('Question 0');
    expect(context.at(-1)).toBe('Still remember?');
  });

  it('resumes the committed checkpoint if transcript persistence fails', async () => {
    const id = crypto.randomUUID();
    let chat = await openConversation(env, scope, id);
    await chat.commit(await invoke(chat, 'Saved question', respond));
    await chat.close();
    chat = await openConversation(env, scope, id);
    const unsaved = await invoke(chat, 'Must not become context', respond);
    await expect(chat.commit(unsaved, async () => { throw new Error('database unavailable'); })).rejects.toThrow('database unavailable');
    await chat.close();
    const detail = await getConversation(env, scope, { conversationId: id, limit: 50 });
    expect(detail.turns.map(turn => turn.question)).toEqual(['Saved question']);
    chat = await openConversation(env, scope, id);
    let context: string[] = [];
    await chat.commit(await invoke(chat, 'Follow-up', (messages, question) => {
      context = messages.map(message => message.text); return respond(messages, question);
    }));
    await chat.close();
    expect(context).toEqual(['Saved question', 'answer', 'Follow-up']);
  });

  it('requires current course access and never lists or loads another actor or visitor', async () => {
    const id = crypto.randomUUID();
    const chat = await openConversation(env, scope, id);
    await chat.commit(await invoke(chat, 'Private question', respond));
    await chat.close();
    expect((await listConversations(env, scope, { limit: 20, offset: 0 })).items.map(item => item.id)).toEqual([id]);
    const other = { ...scope, actorUserId: 'bob' };
    expect((await listConversations(env, other, { limit: 20, offset: 0 })).items).toEqual([]);
    await expect(getConversation(env, other, { conversationId: id, limit: 50 })).rejects.toThrow('Conversation not found');
    await expect(conversationScope(env, 'bob', { courseId: 1 })).rejects.toThrow('Course not found');
    await expect(conversationScope(env, null, { courseId: 1 })).rejects.toThrow('Authentication');
    expect(await conversationScope(env, 'alice', { courseId: 1 })).toEqual(scope);
    await pool.query("DELETE FROM video_course_memberships WHERE user_id = 'alice'");
    await expect(conversationScope(env, 'alice', { courseId: 1 })).rejects.toThrow('Course not found');
    await pool.query("INSERT INTO video_course_memberships VALUES (1, 'alice')");
    const shared = await conversationScope(env, null, { courseId: 1, shareSlug: 'shared' }, 'visitor-a');
    const shareId = crypto.randomUUID();
    const visitor = await openConversation(env, shared, shareId);
    await visitor.commit(await invoke(visitor, 'Visitor question', respond));
    await visitor.close();
    expect((await listConversations(env, shared, { limit: 20, offset: 0 })).items).toEqual([]);
    expect((await listConversations(env, shared, { limit: 20, offset: 0, conversationIds: [shareId] })).items.map(item => item.id)).toEqual([shareId]);
    await expect(getConversation(env, shared, { conversationId: id, limit: 50 })).rejects.toThrow('Conversation not found');
    const stolen = { ...shared, visitorSessionId: 'attacker' };
    expect((await listConversations(env, stolen, { limit: 20, offset: 0, conversationIds: [shareId] })).items).toEqual([]);
    await expect(getConversation(env, stolen, { conversationId: shareId, limit: 50 })).rejects.toThrow('Conversation not found');
    await expect(openConversation(env, stolen, shareId, true)).rejects.toBeInstanceOf(ConversationNotFoundError);
    await deleteConversation(env, stolen, shareId);
    expect((await getConversation(env, shared, { conversationId: shareId, limit: 50 })).turns).toHaveLength(1);
  });

  it('atomically saves and deletes the transcript, course log and checkpoints', async () => {
    const id = crypto.randomUUID();
    const chat = await openConversation(env, scope, id);
    const result = await invoke(chat, 'Question with a course log', respond);
    const log = await chat.commit(result, async (answer, db) => {
      const saved = await createChatLogWithDb(db, { userId: 'alice', courseId: 1, question: answer.queryText,
        answer: answer.answer, retrievedContexts: [], isShared: false });
      return { chatLogId: saved.id, feedback: saved.feedback };
    });
    await expect(deleteConversation(env, scope, id)).rejects.toThrow('Wait for the current answer');
    await chat.close();
    const detail = await getConversation(env, scope, { conversationId: id, limit: 50 });
    expect(detail.turns[0].chatLogId).toBe(log.chatLogId);
    await deleteConversation(env, { ...scope, actorUserId: 'bob' }, id);
    expect((await getConversation(env, scope, { conversationId: id, limit: 50 })).turns).toHaveLength(1);
    await deleteConversation(env, scope, id);
    for (const table of ['chat_conversation_turns', 'chat_logs', 'chat_memory.checkpoints', 'chat_memory.checkpoint_blobs']) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    await expect(openConversation(env, scope, id, true)).rejects.toBeInstanceOf(ConversationNotFoundError);
  });


  it('preserves a real LangChain summary through standard checkpoints and a fresh saver', async () => {
    const id = crypto.randomUUID();
    const requests: Array<{ response_format?: unknown; stream?: boolean; messages: Array<{ content: string }> }> = [];
    vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(requestBodyText(init.body)); requests.push(body);
      const content = body.response_format
        ? JSON.stringify({ segments: [{ text: 'Select a course to retrieve evidence.', sourceIds: [] }] })
        : 'The original topic is perpendicular vectors and their inner product.';
      return Promise.resolve(chatCompletionResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }, !!body.stream, crypto.randomUUID()));
    });
    const modelEnv = { ...env, OPENAI_API_KEY: 'test', OPENAI_BASE_URL: 'https://model.test/v1' } as Bindings;
    const questions = Array.from({ length: 12 }, (_, i) => `Original ${i}: ${'detail '.repeat(1500)}`).concat(['Give an example', 'Explain that again']);
    for (const question of questions) {
      const chat = await openConversation(env, scope, id);
      await chat.commit(await runRag(modelEnv, {
        ownerUserId: 'owner', videoIds: null, locale: 'en', messages: [{ role: 'user', content: question }], memory: chat,
      }));
      await chat.close();
    }
    expect(requests.filter(request => !request.response_format).length).toBeGreaterThanOrEqual(1);
    expect(requests.at(-1)?.messages.some(message => message.content.includes('The original topic is perpendicular vectors'))).toBe(true);
    const detail = await getConversation(env, scope, { conversationId: id, limit: 50 });
    expect(detail.turns).toHaveLength(14);
    expect(detail.turns[0].question).toContain('Original 0:');
    expect(detail.turns[0].question.length).toBeGreaterThan(10000);
    expect((await pool.query('SELECT count(*)::int AS n FROM chat_memory.checkpoints')).rows[0].n).toBeGreaterThan(1);
  });


  it('resumes the committed checkpoint after an abandoned run without pruning history', async () => {
    const id = crypto.randomUUID();
    let chat = await openConversation(env, scope, id);
    await chat.commit(await invoke(chat, 'Committed', respond));
    await chat.close();
    const abandoned = await openConversation(env, scope, id);
    await invoke(abandoned, 'Uncommitted crash', respond);
    await pool.query("UPDATE chat_conversations SET leased_until = now() - interval '1 second'");
    const before = (await pool.query('SELECT count(*)::int AS n FROM chat_memory.checkpoints')).rows[0].n;
    await pruneConversations(env);
    expect((await pool.query('SELECT count(*)::int AS n FROM chat_memory.checkpoints')).rows[0].n).toBe(before);
    chat = await openConversation(env, scope, id, true);
    let context: string[] = [];
    await chat.commit(await invoke(chat, 'Continue', (messages, question) => {
      context = messages.map(message => message.text); return respond(messages, question);
    }));
    await chat.close();
    await abandoned.close();
    expect(context).toEqual(['Committed', 'answer', 'Continue']);
  });

  it('hides expired conversations and refuses to silently recreate a resumed thread', async () => {
    const id = crypto.randomUUID();
    const chat = await openConversation(env, scope, id);
    await chat.commit(await invoke(chat, 'Expired context', respond));
    await chat.close();
    await pool.query("UPDATE chat_conversations SET expires_at = now() - interval '1 second'");
    expect((await listConversations(env, scope, { limit: 20, offset: 0 })).items).toEqual([]);
    await expect(getConversation(env, scope, { conversationId: id, limit: 50 })).rejects.toThrow('Conversation not found');
    await expect(openConversation(env, scope, id, true)).rejects.toBeInstanceOf(ConversationNotFoundError);
    await pruneConversations(env);
    expect((await pool.query('SELECT count(*)::int AS n FROM chat_conversation_turns')).rows[0].n).toBe(0);
  });


  it('starts clean when the first answer was checkpointed but never committed', async () => {
    const id = crypto.randomUUID();
    let chat = await openConversation(env, scope, id);
    const uncommitted = await invoke(chat, 'An invisible failed first answer', respond);
    await expect(chat.commit(uncommitted, async () => { throw new Error('save failed'); })).rejects.toThrow('save failed');
    await chat.close();
    chat = await openConversation(env, scope, id);
    expect(chat.checkpointId).toBeNull();
    let context: string[] = [];
    await chat.commit(await invoke(chat, 'A fresh question', (messages, question) => {
      context = messages.map(message => message.text); return respond(messages, question);
    }));
    await chat.close();
    expect(context).toEqual(['A fresh question']);
    expect((await getConversation(env, scope, { conversationId: id, limit: 50 })).turns.map(turn => turn.question))
      .toEqual(['A fresh question']);
    // The library owns every intermediate snapshot; recovery does not delete them.
    expect((await pool.query('SELECT count(*)::int AS n FROM chat_memory.checkpoints')).rows[0].n).toBeGreaterThan(2);
  });


  it('persists and resumes a streamed answer using the standard graph on PostgreSQL', async () => {
    const id = crypto.randomUUID();
    const standalone = { ownerUserId: 'alice', actorUserId: 'alice', courseId: null, shareSlug: null };
    const modelEnv = { ...env, OPENAI_API_KEY: 'test', OPENAI_BASE_URL: 'https://model.test/v1' } as Bindings;
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(requestBodyText(init.body)); requests.push(body);
      return Promise.resolve(chatCompletionResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ segments: [{ text: 'Select a course to retrieve evidence.', sourceIds: [] }] }),
      } }] }, !!body.stream, crypto.randomUUID()));
    });
    for (const question of ['First question', 'Follow-up']) {
      const chunks = [];
      for await (const chunk of streamChatRag(modelEnv, { ownerUserId: 'alice', videoIds: null, locale: 'en',
        messages: [{ role: 'user', content: question }] }, { id, scope: standalone, resume: question === 'Follow-up' })) chunks.push(chunk);
      expect(chunks.some(chunk => 'part' in chunk)).toBe(true);
      expect(chunks.at(-1)).toMatchObject({ final: { persistedTurn: { chatLogId: null, feedback: null } } });
    }
    expect(requests[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'First question' }),
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ segments: [{ text: 'Select a course to retrieve evidence.', sourceIds: [] }] }) }] }),
      expect.objectContaining({ role: 'user', content: 'Follow-up' }),
    ]));
    const detail = await getConversation(env, standalone, { conversationId: id, limit: 50 });
    expect(detail.isGenerating).toBe(false);
    expect(detail.turns.map(turn => turn.question)).toEqual(['First question', 'Follow-up']);
    expect((await pool.query('SELECT count(*)::int AS n FROM chat_memory.checkpoints')).rows[0].n).toBeGreaterThan(2);
  });

  it.each([false, true])('restores tool messages and their citation registry through a fresh PostgresSaver (stream=%s)', async streaming => {
    const id = crypto.randomUUID();
    const search = vi.fn(async (query: string) => [{ videoId: query === 'first' ? 60 : 61, videoTitle: query,
      startTime: '00:01:00', endTime: '00:01:30', content: `Evidence for ${query}` }]);
    vi.spyOn(vectors, 'openSceneSearch').mockResolvedValue({ search, close: async () => {} });
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let calls = 0;
    vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(requestBodyText(init.body)); bodies.push(body);
      const call = ++calls;
      const query = call === 1 ? 'first' : call === 4 ? 'second' : null;
      const message = query ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${call}`, type: 'function' as const,
        function: { name: 'search_scenes', arguments: JSON.stringify({ query, video_ids: null }) } }] }
        : { role: 'assistant', content: JSON.stringify({ segments: [{ text: 'Grounded answer.', sourceIds: call === 5 ? [1, 2] : [1] }] }) };
      return Promise.resolve(chatCompletionResponse({ choices: [{ finish_reason: query ? 'tool_calls' : 'stop', message }] }, !!body.stream, crypto.randomUUID()));
    });
    const modelEnv = { ...env, OPENAI_API_KEY: 'test', OPENAI_BASE_URL: 'https://model.test/v1' } as Bindings;
    for (const question of ['Find first', 'Explain it again', 'Find second']) {
      const params = { ownerUserId: 'owner', videoIds: [60, 61], courseId: 1, locale: 'en', messages: [{ role: 'user', content: question }] };
      const request = { id, scope, resume: question !== 'Find first' };
      if (streaming) {
        const chunks = [];
        for await (const chunk of streamChatRag(modelEnv, params, request)) chunks.push(chunk);
        expect(chunks.at(-1)).toHaveProperty('final.persistedTurn');
      } else await runChatRag(modelEnv, params, request);
    }
    expect(search).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(bodies[2].messages.filter(message => message.role === 'tool'))).toContain('Evidence for first');
    const detail = await getConversation(env, scope, { conversationId: id, limit: 50 });
    expect(detail.turns[1].answer.segments[0].sourceIds).toEqual([1]);
    expect(detail.turns[2].answer.segments[0].sourceIds).toEqual([1, 2]);
    expect(detail.turns[2].answer.sources).toEqual([expect.objectContaining({ id: 1, video_id: 60 }), expect.objectContaining({ id: 2, video_id: 61 })]);
    const chat = await openConversation(env, scope, id, true);
    try {
      const snapshot = await chat.saver.get({ configurable: { thread_id: chat.threadId, checkpoint_id: chat.checkpointId } });
      const messages = snapshot!.channel_values.messages as BaseMessage[];
      expect(messages.filter(message => message.type === 'tool')).toHaveLength(2);
      expect(snapshot!.channel_values.evidenceSources).toHaveLength(2);
    } finally { await chat.close(); }
  });

});
