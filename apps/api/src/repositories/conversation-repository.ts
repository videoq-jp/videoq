import type {Bindings} from '../types/bindings';
import type {ConversationScope} from '../persistence/contracts/conversation';
import {openPersistenceConversation,prunePersistenceConversations} from '../persistence/factory';
export {conversationThreadId} from '../shared/conversation-scope';
export {CONVERSATION_CHECKPOINT_SCHEMA,ConversationNotFoundError,ConversationBusyError} from '../persistence/contracts/conversation';
export type {ConversationScope,PersistedConversationAnswer,PersistConversationLog} from '../persistence/contracts/conversation';
export const openConversation=(env:Bindings,scope:ConversationScope,id:string,requireExisting=false)=>openPersistenceConversation(env,scope,id,requireExisting);
export const pruneConversations=(env:Bindings)=>prunePersistenceConversations(env);
