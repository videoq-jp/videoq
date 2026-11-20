import { expect, it } from 'vitest';
import { validConversationQuestion } from '@videoq/domain/chat';
import { chatInputSchemas } from '../../../packages/trpc/src/inputs/chat';
import { chatMessageBodySchema } from '../src/features/chat/schemas';

const id = '11111111-1111-4111-8111-111111111111';
it.each([
  { roles: ['user'], conversationId: id, valid: true },
  { roles: ['assistant'], conversationId: id, valid: false },
  { roles: ['user', 'assistant', 'user'], conversationId: id, valid: false },
  { roles: ['user', 'user'], conversationId: id, valid: false },
  { roles: ['user', 'assistant', 'user'], conversationId: undefined, valid: true },
])('shares saved-conversation question eligibility across core, RPC and raw HTTP ($roles, $conversationId)', ({ roles, conversationId, valid }) => {
  const messages = roles.map(role => ({ role, content: 'text' }));
  expect(validConversationQuestion(messages, conversationId)).toBe(valid);
  for (const parsed of [
    chatInputSchemas['chat.send'].safeParse({ messages, conversationId, courseId: 7 }),
    chatMessageBodySchema.safeParse({ messages, conversation_id: conversationId, course_id: 7 }),
  ]) {
    expect(parsed.success).toBe(valid);
    if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ['messages'], message: 'A conversation request requires one user question.' }));
  }
});
