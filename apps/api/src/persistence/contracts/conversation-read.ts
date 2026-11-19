import type { LtiDataSubject } from "./lti-subject";
import type { ChatAnswer } from '../../application/models';

export type ConversationScope={ownerUserId:string;actorUserId:string|null;courseId:number|null;shareSlug:string|null;visitorSessionId?:string;ltiSubject?:LtiDataSubject};

export type ConversationListInput={conversationIds?:string[];limit:number;offset:number};
export type ConversationDetailInput={conversationId:string;beforeTurnId?:string;limit:number};
export type ConversationSummary={id:string;title:string;createdAt:string;updatedAt:string;isGenerating:boolean};
export type ConversationTurn={id:string;question:string;answer:ChatAnswer;createdAt:string;chatLogId:number|null;feedback:'good'|'bad'|null};
export interface ConversationRepository {
  list(scope:ConversationScope,input:ConversationListInput):Promise<{items:ConversationSummary[];hasMore:boolean}>;
  detail(scope:ConversationScope,input:ConversationDetailInput):Promise<ConversationSummary & {turns:ConversationTurn[];hasMore:boolean}>;
  delete(scope:ConversationScope,id:string):Promise<{success:true}>;
}
