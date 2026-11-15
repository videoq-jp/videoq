import { getCourseWithMembers } from '../../repositories/chat-repository';
import type {ConversationScope,ConversationListInput,ConversationDetailInput} from '../../persistence/contracts/conversation';
import {createConversationRepository} from '../../persistence/factory';
import { apiNotFound, ApiError } from '../../shared/errors';
import { createChatFeedbackToken } from '../../lib/chat-feedback-token';
import type { Bindings } from '../../types/bindings';

type AccessInput = { courseId?: number | null; shareSlug?: string };
export async function conversationScope(env: Bindings, userId: string | null, input: AccessInput, visitorSessionId?: string): Promise<ConversationScope> {
  if (!userId && !input.shareSlug) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication is required.');
  if (input.shareSlug && !input.courseId) throw new ApiError(400, 'VALIDATION_ERROR', 'Course ID is required.');
  const course = input.courseId ? await getCourseWithMembers(env, {
    courseId: input.courseId, userId: input.shareSlug ? null : userId, shareToken: input.shareSlug,
  }) : null;
  if (input.courseId && !course) throw apiNotFound('Course not found.');
  return { ownerUserId: course?.userId ?? userId!, actorUserId: input.shareSlug ? null : userId,
    courseId: course?.id ?? null, shareSlug: input.shareSlug ?? null, ...(input.shareSlug ? { visitorSessionId } : {}) };
}

export async function listConversations(env:Bindings,scope:ConversationScope,input:ConversationListInput) {
  return (await createConversationRepository(env)).list(scope,input);
}
export async function getConversation(env:Bindings,scope:ConversationScope,input:ConversationDetailInput) {
  const detail=await (await createConversationRepository(env)).detail(scope,input);
  const turns=await Promise.all(detail.turns.map(async turn=>{
    const {createdAt,...rest}=turn;
    if(scope.ltiSubject?.resourceVideoIds && turn.answer.sources.some(source=>!scope.ltiSubject!.resourceVideoIds.includes(source.video_id)))throw apiNotFound('Conversation not found.');
    return {...rest,...(scope.ltiSubject?{createdAt}:{}),...(scope.shareSlug && turn.chatLogId!==null
      ?{feedbackToken:await createChatFeedbackToken(env,turn.chatLogId,scope.shareSlug)}:{})};
  }));
  return {...detail,turns};
}
export async function deleteConversation(env:Bindings,scope:ConversationScope,id:string) {
  return (await createConversationRepository(env)).delete(scope,id);
}
