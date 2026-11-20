import type { GenerationResult } from "../../application/answer-generation";
import type {CreateChatLogInput} from "./chat-repository";
export const CONVERSATION_CHECKPOINT_SCHEMA='chat_memory';
export type { ConversationScope, ConversationListInput, ConversationDetailInput, ConversationSummary, ConversationTurn, ConversationRepository } from './conversation-read';
export type PersistedConversationAnswer={chatLogId:number|null;feedback:string|null};
/** Prepare business data only; the persistence adapter owns the transaction. */
export type PersistConversationLog=(result:GenerationResult)=>CreateChatLogInput|null|Promise<CreateChatLogInput|null>;
export interface OpenConversation<Checkpoint> {
  threadId:string;checkpointId:string|null;saver:Checkpoint;
  commit(result:GenerationResult,prepareLog?:PersistConversationLog):Promise<PersistedConversationAnswer>;
  close():Promise<void>;
}
export class ConversationNotFoundError extends Error {constructor(){super('This conversation has expired or was deleted. Start a new conversation.');}}
export class ConversationBusyError extends Error {constructor(){super('This conversation is already generating an answer.');}}
