import type { ConversationRepository, ConversationScope, ConversationListInput, ConversationDetailInput } from '../../persistence/contracts/conversation-read';
import type { ChatContextInput, GroupChatContext } from '../../persistence/contracts/chat-repository';
import { ApplicationError, notFound } from '../../application/errors';

export interface ConversationDependencies {
  conversations: ConversationRepository;
  courseContext(input: ChatContextInput): Promise<GroupChatContext | null>;
  feedbackToken(logId: number, shareSlug: string): Promise<string>;
}

type AccessInput = { courseId?: number | null; shareSlug?: string };
export function createConversationService(deps: ConversationDependencies) {
  async function conversationScope(userId: string | null, input: AccessInput, visitorSessionId?: string): Promise<ConversationScope> {
    if (!userId && !input.shareSlug) throw new ApplicationError('unauthorized', 'UNAUTHORIZED', 'Authentication is required.');
    if (input.shareSlug && !input.courseId) throw new ApplicationError('validation', 'VALIDATION_ERROR', 'Course ID is required.');
    const course = input.courseId ? await deps.courseContext({
      courseId: input.courseId, userId: input.shareSlug ? null : userId, shareToken: input.shareSlug,
    }) : null;
    if (input.courseId && !course) throw notFound('Course not found.');
    return { ownerUserId: course?.userId ?? userId!, actorUserId: input.shareSlug ? null : userId,
      courseId: course?.id ?? null, shareSlug: input.shareSlug ?? null, ...(input.shareSlug ? { visitorSessionId } : {}) };
  }

  async function listConversations(scope:ConversationScope,input:ConversationListInput) {
    return deps.conversations.list(scope,input);
  }
  async function getConversation(scope:ConversationScope,input:ConversationDetailInput) {
    const detail=await deps.conversations.detail(scope,input);
    const turns=await Promise.all(detail.turns.map(async turn=>{
      const {createdAt,...rest}=turn;
      if(scope.ltiSubject?.resourceVideoIds && turn.answer.sources.some(source=>!scope.ltiSubject!.resourceVideoIds.includes(source.video_id)))throw notFound('Conversation not found.');
      return {...rest,...(scope.ltiSubject?{createdAt}:{}),...(scope.shareSlug && turn.chatLogId!==null
        ?{feedbackToken:await deps.feedbackToken(turn.chatLogId,scope.shareSlug)}:{})};
    }));
    return {...detail,turns};
  }
  async function deleteConversation(scope:ConversationScope,id:string) {
    return deps.conversations.delete(scope,id);
  }

  return { conversationScope, listConversations, getConversation, deleteConversation };
}
