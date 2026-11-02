import { afterEach, expect, it, vi } from 'vitest';
import { MemorySaver, StateGraph, StateSchema, MessagesValue, START, END } from '@langchain/langgraph';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { ConversationCommitError } from '../src/lib/conversation';
import { createAgent } from 'langchain';
import { runRag, streamRag, type RagParams, type RagResult } from '../src/lib/rag';
import { createChatModel } from '../src/lib/chat-model';
import { openSceneSearch } from '../src/repositories/vector-repository';
import { conversationThreadId } from '../src/repositories/conversation-repository';
import { AnswerCostLedger } from '../src/lib/answer-cost-ledger';
import { chatCompletionResponse } from './helpers/chat-completion-response';
import { stalledChatResponse } from './helpers/stalled-chat-response';
import { requestBodyText } from './helpers/request-body';
import type { Bindings } from '../src/types/bindings';

vi.mock('../src/repositories/vector-repository', () => ({ openSceneSearch: vi.fn() }));

const ENV = { OPENAI_API_KEY: 'test', OPENAI_BASE_URL: 'https://llm.test/v1' } as Bindings;
const PARAMS: RagParams = { ownerUserId: 'owner', videoIds: null, locale: 'en', messages: [] };
const ANSWER = { segments: [{ text: 'A course must be selected to retrieve evidence.', sourceIds: [] }] };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function stubModel() {
  const requests: Array<{ messages: Array<{ role: string; content: string }>; stream?: boolean; response_format?: unknown; max_tokens?: number; max_completion_tokens?: number }> = [];
  vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(requestBodyText(init.body));
    requests.push(body);
    return Promise.resolve(chatCompletionResponse({ choices: [{ finish_reason: 'stop', message: {
      role: 'assistant', content: !body.response_format
        ? 'The user is studying the dot product. Keep examples about perpendicular vectors.' : JSON.stringify(ANSWER),
    } }] }, !!body.stream, crypto.randomUUID()));
  });
  return requests;
}
const memory = (saver: MemorySaver, threadId = 'chat', checkpointId: string | null = null) => ({ saver, threadId, checkpointId });
const params = (question: string, state: ReturnType<typeof memory>, extra = {}) => ({
  ...PARAMS, ...extra, messages: [{ role: 'user', content: question }], memory: state,
});
async function seed(saver: MemorySaver, threadId = 'chat') {
  const messages = Array.from({ length: 12 }, (_, index) => [
    new HumanMessage(`Dot product question ${index}: ${'old context '.repeat(150)}`),
    new AIMessage(`Old explanation ${index}: ${'answer '.repeat(150)}`),
  ]).flat();
  const agent = createAgent({ model: createChatModel(ENV, { maxTokens: 1024, timeoutMs: 1000 }), checkpointer: saver });
  const config = await agent.graph.updateState({ configurable: { thread_id: threadId } }, { messages });
  return { checkpointId: config.configurable!.checkpoint_id as string, messages };
}

it('isolates threads by actor, course, share route and conversation ID', async () => {
  const scope = { ownerUserId: 'owner', actorUserId: 'alice', courseId: 1, shareSlug: null };
  const id = crypto.randomUUID();
  const hashes = await Promise.all([
    conversationThreadId(scope, id), conversationThreadId({ ...scope, actorUserId: 'bob' }, id),
    conversationThreadId({ ...scope, courseId: 2 }, id),
    conversationThreadId({ ...scope, actorUserId: null, shareSlug: 'share', visitorSessionId: 'visitor-a' }, id),
    conversationThreadId(scope, crypto.randomUUID()),
  ]);
  expect(new Set(hashes).size).toBe(5);
  expect(await conversationThreadId(scope, id)).toBe(hashes[0]);
});

it.each([false, true])('resumes native agent messages without reconstructing the conversation (stream=%s)', async streaming => {
  const requests = stubModel();
  const saver = new MemorySaver();
  const first = await runRag(ENV, params('first', memory(saver)));
  const next = params('follow-up', memory(saver, 'chat', first.checkpointId));
  if (streaming) {
    const chunks = [];
    for await (const chunk of streamRag(ENV, next)) chunks.push(chunk);
    expect(chunks.some(chunk => 'part' in chunk)).toBe(true);
    expect(chunks.at(-1)).toHaveProperty('final.checkpointId');
  } else await runRag(ENV, next);
  expect(requests.at(-1)?.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'user', content: 'first' }),
    expect.objectContaining({ role: 'assistant', content: JSON.stringify(ANSWER) }),
    expect.objectContaining({ role: 'user', content: 'follow-up' }),
  ]));
  await runRag(ENV, params('different', memory(saver, 'other')));
  expect(requests.at(-1)?.messages.some(message => message.content === 'first')).toBe(false);
});

it.each([false, true])('persists real middleware compaction directly in agent state (stream=%s)', async streaming => {
  const requests = stubModel();
  const saver = new MemorySaver();
  const { checkpointId, messages } = await seed(saver);
  const costLedger = new AnswerCostLedger();
  const question = 'Can you give another perpendicular-vector example?';
  const input = params(question, memory(saver, 'chat', checkpointId), { costLedger });
  let result;
  if (streaming) {
    const chunks = [];
    for await (const chunk of streamRag(ENV, input)) chunks.push(chunk);
    expect(JSON.stringify(chunks)).not.toContain('The user is studying the dot product');
    result = chunks.findLast(chunk => 'final' in chunk)!.final;
  } else result = await runRag(ENV, input);
  expect(requests.filter(request => !request.response_format)).toHaveLength(1);
  expect(requests.find(request => !request.response_format)).not.toHaveProperty('max_tokens');
  expect(requests.find(request => !request.response_format)).not.toHaveProperty('max_completion_tokens');
  expect(costLedger.calls.some(call => call.kind === 'conversation_summary' && call.status === 'completed')).toBe(true);
  const persisted = await saver.get({ configurable: { thread_id: 'chat', checkpoint_id: result.checkpointId } });
  const state = persisted!.channel_values.messages as Array<{ text: string }>;
  expect(state).toHaveLength(22);
  expect(state.length).toBeLessThan(messages.length);
  expect(state[0].text).toContain('The user is studying the dot product');
  expect(state.at(-2)!.text).toBe(question);
  expect(state.at(-1)!.text).toBe(JSON.stringify(ANSWER));
  await runRag(ENV, params('Explain that again', memory(saver, 'chat', result.checkpointId)));
  expect(requests.filter(request => !request.response_format).length).toBeGreaterThanOrEqual(1);
  expect(requests.at(-1)?.messages.some(message => message.content.includes('The user is studying the dot product'))).toBe(true);
});

it.each(['failure', 'empty'])('keeps the committed context when summarization returns %s', async mode => {
  const saver = new MemorySaver();
  const { checkpointId, messages } = await seed(saver);
  vi.stubGlobal('fetch', () => Promise.resolve(mode === 'failure' ? new Response('unavailable', { status: 503 })
    : chatCompletionResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }] }, false)));
  await expect(runRag(ENV, params('Explain', memory(saver, 'chat', checkpointId))))
    .rejects.toThrow('Conversation summarization failed');
  const committed = await saver.get({ configurable: { thread_id: 'chat', checkpoint_id: checkpointId } });
  expect((committed!.channel_values.messages as HumanMessage[]).map(message => message.text)).toEqual(messages.map(message => message.text));
});

it('rejects a missing committed checkpoint before calling the model', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(runRag(ENV, params('follow-up', memory(new MemorySaver(), 'known', 'missing'))))
    .rejects.toThrow('committed conversation checkpoint is unavailable');
  expect(fetch).not.toHaveBeenCalled();
});

it('ignores an uncommitted first answer and its state on the next request', async () => {
  const requests = stubModel();
  const saver = new MemorySaver();
  await runRag(ENV, params('invisible answer', memory(saver)));
  await runRag(ENV, params('new question', memory(saver)));
  expect(requests.at(-1)?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['new question']);
});

it('cancels native agent streaming when the consumer stops reading', async () => {
  let upstream: AbortSignal | undefined;
  vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
    upstream = init.signal!;
    return Promise.resolve(stalledChatResponse(upstream, () => {}, true, '{"segments":[{"text":"First'));
  });
  const stream = streamRag(ENV, params('question', memory(new MemorySaver())));
  expect((await stream.next()).value).toHaveProperty('part');
  await expect(stream.return(undefined)).resolves.toHaveProperty('done', true);
  expect(upstream?.aborted).toBe(true);
});


it.each([false, true])('retains native tool history and stable citations across answers and compaction (stream=%s)', async streaming => {
  const saver = new MemorySaver();
  const queries: string[] = [];
  vi.mocked(openSceneSearch).mockImplementation(async () => ({
    search: async query => {
      queries.push(query);
      return [{ videoId: query === 'first' ? 60 : 61, videoTitle: query,
        startTime: '00:01:00', endTime: '00:01:30', content: `Evidence for ${query}` }];
    }, close: async () => {},
  }));
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; response_format?: unknown }> = [];
  let call = 0;
  vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(requestBodyText(init.body)); requests.push(body);
    if (!body.response_format) return Promise.resolve(chatCompletionResponse({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: 'Evidence for first is sourceId 1; evidence for second is sourceId 2.' },
    }] }, false));
    const turn = ++call;
    const query = turn === 1 ? 'first' : turn === 4 ? 'second' : undefined;
    const message = query ? { role: 'assistant', content: null, tool_calls: [{ id: `tool_${turn}`, type: 'function' as const,
      function: { name: 'search_scenes', arguments: JSON.stringify({ query, video_ids: null }) } }] }
      : { role: 'assistant', content: JSON.stringify({ segments: [{ text: 'Grounded answer.', sourceIds: turn === 5 ? [1, 2] : [1] }] }) };
    return Promise.resolve(chatCompletionResponse({ choices: [{ finish_reason: query ? 'tool_calls' : 'stop', message }] }, !!body.stream, crypto.randomUUID()));
  });
  let checkpointId: string | null = null;
  const execute = async (question: string, videoIds = [60, 61]) => {
    const input = { ...params(question, memory(saver, 'sources', checkpointId)), videoIds };
    let result: RagResult | undefined;
    if (streaming) {
      const chunks = [];
      for await (const chunk of streamRag(ENV, input)) { chunks.push(chunk); if ('final' in chunk) result = chunk.final; }
      expect(chunks.filter(chunk => 'source' in chunk).map(chunk => chunk.source)).toEqual(result!.answer.sources);
    } else result = await runRag(ENV, input);
    checkpointId = result!.checkpointId!;
    return result!;
  };
  const first = await execute('Find first');
  expect(first.answer.sources).toEqual([expect.objectContaining({ id: 1, video_id: 60 })]);
  const followup = await execute('Explain that again');
  expect(queries).toEqual(['first']);
  expect(followup.answer.segments[0].sourceIds).toEqual([1]);
  expect(JSON.stringify(requests.at(-1)?.messages.filter(message => message.role === 'tool'))).toContain('Evidence for first');
  const next = await execute('Find second');
  expect(queries).toEqual(['first', 'second']);
  expect(next.answer.sources).toEqual([expect.objectContaining({ id: 1, video_id: 60 }), expect.objectContaining({ id: 2, video_id: 61 })]);
  expect(next.answer.segments[0].sourceIds).toEqual([1, 2]);
  const snapshot = await saver.get({ configurable: { thread_id: 'sources', checkpoint_id: checkpointId } });
  expect((snapshot!.channel_values.messages as HumanMessage[]).filter(message => message.type === 'tool')).toHaveLength(2);
  // Grow past the default 20 retained messages before triggering compaction.
  for (let i = 0; i < 6; i++) await execute(`Follow-up ${i}`);
  // A large new question causes the built-in middleware to compact old turns.
  const compacted = await execute('More detail '.repeat(4000));
  expect(requests.some(request => !request.response_format)).toBe(true);
  expect(compacted.answer.sources.map(source => source.id)).toEqual([1, 2]);
  // Sources removed from the current authorized video set cannot be cited;
  // their IDs are reserved, never reassigned to another video.
  const narrowed = await execute('Only the second video is available', [61]);
  expect(narrowed.answer.sources).toEqual([expect.objectContaining({ id: 2, video_id: 61 })]);
  expect(narrowed.answer.segments[0].sourceIds).toEqual([]);
  checkpointId = null;
  const fresh = await execute('Retry without any committed answer');
  expect(fresh.answer.sources).toEqual([]);
  expect(fresh.answer.segments[0].sourceIds).toEqual([]);
  expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Evidence for first');
});


it('reads an existing parent-graph checkpoint without a migration or history rewrite', async () => {
  const requests = stubModel();
  const saver = new MemorySaver();
  // Legacy graph exists only as a fixture; production no longer creates it.
  const legacy = new StateGraph(new StateSchema({ messages: MessagesValue, question: z.string() }))
    .addNode('answer', state => ({ messages: [new HumanMessage(state.question), new AIMessage('Legacy plain answer')] }))
    .addEdge(START, 'answer').addEdge('answer', END).compile({ checkpointer: saver });
  await legacy.invoke({ question: 'Legacy question' }, { configurable: { thread_id: 'legacy' }, durability: 'exit' });
  const checkpointId = (await saver.getTuple({ configurable: { thread_id: 'legacy' } }))!.config.configurable!.checkpoint_id as string;
  await runRag(ENV, params('Continue', memory(saver, 'legacy', checkpointId)));
  expect(requests.at(-1)?.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'user', content: 'Legacy question' }),
    expect.objectContaining({ role: 'assistant', content: 'Legacy plain answer' }),
    expect.objectContaining({ role: 'user', content: 'Continue' }),
  ]));
});

it('keeps the committed state when an asynchronous checkpoint write fails', async () => {
  stubModel();
  const saver = new MemorySaver();
  const first = await runRag(ENV, params('Committed', memory(saver)));
  const put = vi.spyOn(saver, 'put').mockRejectedValue(new Error('checkpoint database unavailable'));
  await expect(runRag(ENV, params('Not committed', memory(saver, 'chat', first.checkpointId))))
    .rejects.toBeInstanceOf(ConversationCommitError);
  put.mockRestore();
  const committed = await saver.get({ configurable: { thread_id: 'chat', checkpoint_id: first.checkpointId } });
  expect(JSON.stringify(committed!.channel_values.messages)).not.toContain('Not committed');
});
