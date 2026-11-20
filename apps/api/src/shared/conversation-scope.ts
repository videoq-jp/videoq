import { conversationThreadInput } from '../application/conversation-scope';
import type { ConversationScope } from '../persistence/contracts/conversation';
import { sha256Hex } from './crypto';
import { asApiError } from './errors';

export async function conversationThreadId(scope: ConversationScope, conversationId: string): Promise<string> {
  let input: string;
  try { input = conversationThreadInput(scope, conversationId); }
  catch (error) { throw asApiError(error) ?? error; }
  return sha256Hex(input);
}
