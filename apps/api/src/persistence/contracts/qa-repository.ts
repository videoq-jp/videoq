import type {LtiSessionProof} from '../../application/lti-session-proof';
/** Internal grant, constructed only after a fresh LMS authorization check. */
export type LtiQaPrincipal = {
  kind: "lti"; courseId: number; ownerUserId: string; authorId: string; videoIds: readonly number[];
  sessionProof?: LtiSessionProof;
  permissions: { view: boolean; post: boolean; vote: boolean; deleteOwn: boolean; moderate: boolean; instructor: boolean };
};
export type QaPrincipal = string | null | LtiQaPrincipal;
export type QaAccess = { courseId: number; shareSlug?: string };
export type QaListInput = QaAccess & {
  search: string; videoId?: number; unanswered: boolean; sort: 'recent' | 'votes'; offset: number; limit: number;
};
export type QaGetInput = QaAccess & { questionId: string; offset: number; limit: number };
type QuestionAccess = QaAccess & { questionId: string };
export interface QaMutationInputs {
  'qa.ask': QaAccess & { title: string; body: string; videoId: number | null };
  'qa.updateQuestion': QuestionAccess & { title: string; body: string };
  'qa.deleteQuestion': QuestionAccess;
  'qa.reply': QuestionAccess & { body: string };
  'qa.updateReply': QuestionAccess & { replyId: string; body: string };
  'qa.deleteReply': QuestionAccess & { replyId: string };
  'qa.vote': QuestionAccess & { voted: boolean };
  'qa.feature': QuestionAccess & { featured: boolean };
}
export type QaCommand = { [Name in keyof QaMutationInputs]: { name: Name; input: QaMutationInputs[Name] } }[keyof QaMutationInputs];
export type QaAuthor = { name: string | null; instructor: boolean; source?: 'videoq' | 'moodle' };
export type QaReply = {
  id: string; body: string; author: QaAuthor; createdAt: string; updatedAt: string; canEdit: boolean; canDelete: boolean;
};
export type QaQuestion = QaReply & {
  title: string; videoId: number | null; videoTitle: string | null; featured: boolean;
  replyCount: number; votes: number; voted: boolean;
};
type QaAbilities = { canPost: boolean; canVote?: boolean; canModerate: boolean };
export type QaListResult = QaAbilities & { items: QaQuestion[]; total: number };
export type QaGetResult = QaAbilities & { question: QaQuestion; replies: QaReply[]; replyTotal: number };
export interface QaRepository {
  list(principal: QaPrincipal, input: QaListInput): Promise<QaListResult>;
  get(principal: QaPrincipal, input: QaGetInput): Promise<QaGetResult>;
  mutate(principal: Exclude<QaPrincipal, null>, command: QaCommand): Promise<{ id: string } | { success: true }>;
}
