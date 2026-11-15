import type {ChatAnswer,ChatSource} from "@videoq/trpc/chat";
import type {LtiDataSubject} from "../../features/lti/identity";
export type ChatQuestionAuthor={user_id:string;username:string;email:string};
export type ChatLogItem={id:number;course:number;asked_by:ChatQuestionAuthor|null;question:string;answer:ChatAnswer;is_shared_origin:boolean;feedback:"good"|"bad"|null;created_at:string};
export type GroupChatContext={id:number;userId:string;memberVideoIds:number[]};
export type ChatContextInput={courseId:number;userId?:string|null;shareToken?:string|null;ltiCourseGrant?:number;ltiVideoGrant?:number[]};
export type CreateChatLogInput={userId:string;courseId:number;question:string;answer:ChatAnswer;isShared:boolean;retrievedContexts:readonly string[];ltiSubject?:LtiDataSubject};
export type ChatHistoryExportRow={created_at:string;asked_by:ChatQuestionAuthor|null;question:string;answer:string;is_shared_origin:boolean;citations:ChatSource[];feedback:string|null};
export type ChatHistoryExportCursor={createdAt:string;id:number};
export type ChatAnalytics={summary:{total_questions:number;date_range:{first:string|null;last:string|null}};time_series:{date:string;count:number}[];feedback:{good:number;bad:number;none:number}};
export type ChatFeedbackInput={userId?:string;shareSlug?:string|null;ltiCourseGrant?:number};
export interface ChatRepository {
  context(params:ChatContextInput):Promise<GroupChatContext|null>;
  create(params:CreateChatLogInput):Promise<{id:number;feedback:string|null}>;
  deleteHistory(courseId:number,userId:string):Promise<{notFound:true}|{ok:true}>;
  exportPage(courseId:number,userId:string,cursor:ChatHistoryExportCursor|null):Promise<{rows:ChatHistoryExportRow[];nextCursor:ChatHistoryExportCursor|null}>;
  feedback(logId:number,feedback:"good"|"bad"|null,options:ChatFeedbackInput):Promise<{notFound:true}|{forbidden:true}|{id:number;feedback:"good"|"bad"|null}>;
  shareExists(slug:string):Promise<boolean>;
  analytics(courseId:number,userId:string):Promise<{notFound:true}|ChatAnalytics>;
  history(courseId:number,userId:string,limit:number,offset:number):Promise<{notFound:true}|{count:number;results:ChatLogItem[]}>;
}
