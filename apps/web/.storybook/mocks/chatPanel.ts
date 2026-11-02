import { applyChatPart, type ChatAnswer } from '@videoq/trpc/chat';
import { http, HttpResponse } from 'msw';
import { fn } from 'storybook/test';
import type { ChatHistoryItem, ChatRequest, ChatStreamEvent } from '../../src/lib/api';
import { answerEvents, courseHistory } from '../fixtures/chatPanel';
import { failure, pending, success, trpcHandler, trpcMutation, trpcQuery } from './network';

export interface ChatPanelScenario {
  events?: ChatStreamEvent[];
  keepOpen?: boolean;
  httpError?: boolean;
  history?: ChatHistoryItem[];
  historyState?: 'pending' | 'error';
  historyRefetch?: 'pending' | 'error';
  feedback?: 'pending' | 'error' | 'retry';
  csv?: 'pending' | 'error';
}
export const chatRequest = fn();
export const historyRequest = fn();
export const feedbackRequest = fn();
export const csvRequest = fn();
export const historyError = '会話履歴を読み込めませんでした / Could not load conversation history';

export function createChatPanelMock(scenario: ChatPanelScenario = {}) {
  const lifetime = new AbortController();
  const streams = new Set<{ send: (events: ChatStreamEvent[]) => void; close: () => void }>();
  const conversations = new Map<string, { id: string; title: string; createdAt: string; updatedAt: string; isGenerating: boolean;
    turns: Array<{ id: string; question: string; answer: ChatAnswer; chatLogId: number | null; feedback: 'good' | 'bad' | null; feedbackToken?: string }>;
    hasMore: boolean }>();
  const history = structuredClone(scenario.history ?? courseHistory);
  let feedbackAttempts = 0;
  for (const request of [chatRequest, historyRequest, feedbackRequest, csvRequest]) request.mockClear();
  const handlers = [
    http.post('/api/chat/messages/stream', async ({ request }) => {
      const body = await request.json() as ChatRequest;
      chatRequest({ ...body, share_slug: new URL(request.url).searchParams.get('share_slug') ?? undefined });
      if (scenario.httpError) return HttpResponse.json({ error: { code: 'STREAM_FAILED', message: 'Connection failed (fixture)' } }, { status: 503 });
      const id = body.conversation_id ?? crypto.randomUUID();
      const question = body.messages.at(-1)?.content ?? '';
      const conversation = conversations.get(id) ?? { id, title: question, createdAt: '2026-11-02T00:00:00Z',
        updatedAt: '2026-11-02T00:00:00Z', isGenerating: true, turns: [], hasMore: false };
      conversation.isGenerating = true;
      conversations.set(id, conversation);
      const draft: ChatAnswer = { segments: [], sources: [] };
      const encoder = new TextEncoder();
      let cleanup = () => {};
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          const connection = {
            send(events: ChatStreamEvent[]) {
              if (!closed) for (const event of events) {
                if (event.type === 'source') draft.sources.push(event.source);
                if (event.type === 'text_delta') applyChatPart(draft, { ...event, type: 'text' });
                if (event.type === 'citation') applyChatPart(draft, event);
                if (event.type === 'done') {
                  conversation.turns.push({ id: String(conversation.turns.length + 1), question, answer: structuredClone(draft),
                    chatLogId: event.chat_log_id, feedback: event.feedback ?? null, feedbackToken: event.feedback_token });
                  conversation.isGenerating = false;
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              }
            },
            close() {
              if (closed) return;
              cleanup();
              controller.close();
            },
          };
          cleanup = () => {
            closed = true;
            conversation.isGenerating = false;
            streams.delete(connection);
            lifetime.signal.removeEventListener('abort', connection.close);
            request.signal.removeEventListener('abort', connection.close);
          };
          streams.add(connection);
          lifetime.signal.addEventListener('abort', connection.close, { once: true });
          request.signal.addEventListener('abort', connection.close, { once: true });
          if (lifetime.signal.aborted || request.signal.aborted) { connection.close(); return; }
          connection.send(scenario.events ?? answerEvents());
          if (!scenario.keepOpen) connection.close();
        },
        cancel() { cleanup(); },
      });
      return new HttpResponse(bodyStream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    }),
    trpcHandler([
      trpcQuery('chat.conversations', input => success({ items: [...conversations.values()]
        .filter(item => item.turns.length && (!input.shareSlug || input.conversationIds?.includes(item.id))), hasMore: false })),
      trpcQuery('chat.conversation', input => {
        const conversation = conversations.get(input.conversationId);
        return conversation ? success(conversation) : failure('Conversation not found', 404);
      }),
      trpcMutation('chat.deleteConversation', input => {
        conversations.delete(input.conversationId); return success({ success: true });
      }),
      trpcQuery('chat.history', input => {
        historyRequest(input);
        const state = historyRequest.mock.calls.length > 1 ? scenario.historyRefetch ?? scenario.historyState : scenario.historyState;
        if (state === 'pending') return pending();
        if (state === 'error') return failure(historyError);
        return success({ data: history, meta: { total: history.length, limit: input.limit ?? 100, offset: input.offset ?? 0 } });
      }),
      trpcMutation('chat.feedback', input => {
        feedbackRequest(input);
        feedbackAttempts++;
        if (scenario.feedback === 'pending') return pending();
        if (scenario.feedback === 'error' || (scenario.feedback === 'retry' && feedbackAttempts === 1)) return failure('Feedback failed (fixture)');
        const item = history.find(item => item.id === input.chatLogId);
        if (item) item.feedback = input.feedback;
        return success({ chat_log_id: input.chatLogId, feedback: input.feedback });
      }),
    ]),
    http.get('/api/chat/courses/:courseId/history.csv', async ({ params }) => {
      csvRequest({ courseId: Number(params.courseId) });
      if (scenario.csv === 'pending' && !lifetime.signal.aborted) await new Promise<void>(resolve => lifetime.signal.addEventListener('abort', () => resolve(), { once: true }));
      if (scenario.csv === 'error' || lifetime.signal.aborted) return new HttpResponse('Export failed (fixture)', { status: 503 });
      return new HttpResponse('question,answer\n"Storybook question","Storybook answer"\n', { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="storybook-chat.csv"' } });
    }),
  ];
  return {
    handlers,
    emit: (events: ChatStreamEvent[]) => { for (const stream of streams) stream.send(events); },
    finish: () => { for (const stream of streams) stream.close(); },
    dispose: () => lifetime.abort(),
    get activeStreams() { return streams.size; },
  };
}
