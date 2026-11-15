import type {BaseCheckpointSaver} from "@langchain/langgraph-checkpoint";
import type {LtiDataSubject} from "../../features/lti/identity";
import type {RagResult} from "../../lib/rag";
import type {CreateChatLogInput} from "./chat-repository";
export const CONVERSATION_CHECKPOINT_SCHEMA='chat_memory';
export type ConversationScope={ownerUserId:string;actorUserId:string|null;courseId:number|null;shareSlug:string|null;visitorSessionId?:string;ltiSubject?:LtiDataSubject};
export type PersistedConversationAnswer={chatLogId:number|null;feedback:string|null};
/** Prepare business data only; the persistence adapter owns the transaction. */
export type PersistConversationLog=(result:RagResult)=>CreateChatLogInput|null|Promise<CreateChatLogInput|null>;
export interface OpenConversation {
  threadId:string;checkpointId:string|null;saver:BaseCheckpointSaver;
  commit(result:RagResult,prepareLog?:PersistConversationLog):Promise<PersistedConversationAnswer>;
  close():Promise<void>;
}
export class ConversationNotFoundError extends Error {constructor(){super('This conversation has expired or was deleted. Start a new conversation.');}}
export class ConversationBusyError extends Error {constructor(){super('This conversation is already generating an answer.');}}

export type ConversationListInput={conversationIds?:string[];limit:number;offset:number};
export type ConversationDetailInput={conversationId:string;beforeTurnId?:string;limit:number};
export type ConversationSummary={id:string;title:string;createdAt:string;updatedAt:string;isGenerating:boolean};
export type ConversationTurn={id:string;question:string;answer:import('@videoq/trpc/chat').ChatAnswer;createdAt:string;chatLogId:number|null;feedback:'good'|'bad'|null};
export interface ConversationRepository {
  list(scope:ConversationScope,input:ConversationListInput):Promise<{items:ConversationSummary[];hasMore:boolean}>;
  detail(scope:ConversationScope,input:ConversationDetailInput):Promise<ConversationSummary & {turns:ConversationTurn[];hasMore:boolean}>;
  delete(scope:ConversationScope,id:string):Promise<{success:true}>;
}
