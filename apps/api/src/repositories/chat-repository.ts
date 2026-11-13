import type {Bindings} from "../types/bindings";
import type {ChatContextInput,CreateChatLogInput,ChatFeedbackInput,ChatHistoryExportCursor,ChatHistoryExportRow} from "../persistence/contracts/chat-repository";
import {createChatRepository} from "../persistence/factory";
export type {ChatLogItem,GroupChatContext,ChatHistoryExportRow,ChatAnalytics} from "../persistence/contracts/chat-repository";
// Compatibility for PostgreSQL conversation transactions not yet migrated.
export {createChatLogWithDb} from "../persistence/postgres/chat-repository";
export const getCourseWithMembers=async(env:Bindings,params:ChatContextInput)=>(await createChatRepository(env)).context(params);
export const createChatLog=async(env:Bindings,params:CreateChatLogInput)=>(await createChatRepository(env)).create(params);
export const deleteCourseChatLogs=async(env:Bindings,courseId:number,userId:string)=>(await createChatRepository(env)).deleteHistory(courseId,userId);
export const updateChatLogFeedback=async(env:Bindings,logId:number,feedback:"good"|"bad"|null,options:ChatFeedbackInput)=>(await createChatRepository(env)).feedback(logId,feedback,options);
export const shareSlugExists=async(env:Bindings,slug:string)=>(await createChatRepository(env)).shareExists(slug);
export const getCourseChatAnalytics=async(env:Bindings,courseId:number,userId:string)=>(await createChatRepository(env)).analytics(courseId,userId);
export const getCourseChatHistory=async(env:Bindings,courseId:number,userId:string,limit:number,offset:number)=>(await createChatRepository(env)).history(courseId,userId,limit,offset);
export async function* iterateCourseChatHistoryForExport(env:Bindings,courseId:number,userId:string):AsyncGenerator<ChatHistoryExportRow> {
  const repository=await createChatRepository(env);let cursor:ChatHistoryExportCursor|null=null;
  do {
    const page=await repository.exportPage(courseId,userId,cursor);
    for (const row of page.rows) yield row;
    cursor=page.nextCursor;
  } while (cursor);
}
