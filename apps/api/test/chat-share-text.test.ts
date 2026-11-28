import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { inputSchemas } from '@videoq/trpc/inputs';
import { createChatHistoryService, type ChatHistoryDependencies } from '../src/features/chat/service';
import { createConversationService, type ConversationDependencies } from '../src/features/chat/conversation-service';
import { chatRoutes } from '../src/features/chat/routes';
import { onError } from '../src/middleware/error-handler';
import type { AppEnv } from '../src/types/bindings';

const auth = vi.hoisted(() => ({ resolve: vi.fn(), exists: vi.fn() }));
vi.mock('../src/middleware/auth', () => ({ resolveAuth: auth.resolve, sessionMethod: vi.fn(), requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../src/integrations/chat-history', () => ({ shareSlugExists: auth.exists }));
const nul = 'bad\0slug';

it.each(['chat.conversations', 'chat.conversation', 'chat.deleteConversation', 'chat.send', 'chat.feedback'] as const)('rejects NUL shareSlug in %s', procedure => {
  const input = { shareSlug: nul, courseId: 1, conversationId: '00000000-0000-4000-8000-000000000001', chatLogId: 1, feedback: 'good', messages: [{ role: 'user', content: 'question' }] };
  expect(inputSchemas[procedure].safeParse(input).success).toBe(false);
  expect(inputSchemas[procedure].safeParse({ ...input, shareSlug: '日本語 😀 %_ Mixed-Case' }).success).toBe(true);
});

it('rejects a direct shared lookup before the persistence port', async () => {
  const deps: ChatHistoryDependencies = { chat: { shareExists: vi.fn(), history: vi.fn(), deleteHistory: vi.fn(), analytics: vi.fn(), feedback: vi.fn() }, courseOwnedBy: vi.fn(), historyRows: vi.fn(), verifyFeedbackToken: vi.fn() };
  await expect(createChatHistoryService(deps).shareSlugExists(nul)).rejects.toMatchObject({ kind: 'validation' });
  expect(deps.chat.shareExists).not.toHaveBeenCalled();
  await expect(createChatHistoryService(deps).submitFeedback(1, 'good', { shareSlug: nul })).rejects.toMatchObject({ kind: 'validation' });
  expect(deps.verifyFeedbackToken).not.toHaveBeenCalled();
  expect(deps.chat.feedback).not.toHaveBeenCalled();
});

it('rejects direct conversation scope input before context lookup', async () => {
  const deps: ConversationDependencies = { conversations: { list: vi.fn(), detail: vi.fn(), delete: vi.fn() }, courseContext: vi.fn(), feedbackToken: vi.fn() };
  for (const userId of [null, 'owner']) {
    await expect(createConversationService(deps).conversationScope(userId, { courseId: 1, shareSlug: nul })).rejects.toMatchObject({ kind: 'validation' });
  }
  expect(deps.courseContext).not.toHaveBeenCalled();
});

it.each(['share_slug', 'share_token'])('rejects %s before anonymous or signed-in authentication and shared SQL', async parameter => {
  const app = new Hono<AppEnv>(); app.onError(onError); app.route('/chat', chatRoutes);
  for (const outcome of [{ kind: 'absent' }, { kind: 'ok', userId: 'owner', via: 'session' }]) {
    auth.resolve.mockReset().mockResolvedValue(outcome); auth.exists.mockReset().mockResolvedValue(false);
    const response = await app.request(`/chat/messages/stream?${parameter}=bad%00slug`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(auth.resolve).not.toHaveBeenCalled(); expect(auth.exists).not.toHaveBeenCalled();
  }
});

it('preserves anonymous missing-share authorization and primary alias precedence', async () => {
  const app = new Hono<AppEnv>(); app.onError(onError); app.route('/chat', chatRoutes);
  auth.resolve.mockReset().mockResolvedValue({ kind: 'absent' }); auth.exists.mockReset().mockResolvedValue(false);
  const response = await app.request('/chat/messages/stream?share_slug=valid&share_token=ignored%00alias', { method: 'POST', body: '{}' }, {});
  expect(response.status).toBe(401); expect(auth.exists).toHaveBeenCalledWith({}, 'valid');
});
