import type { ChatSource } from "./models";
export type ChatQuestionAuthor={user_id:string;username:string;email:string};
export type ChatHistoryExportRow={created_at:string;asked_by:ChatQuestionAuthor|null;question:string;answer:string;is_shared_origin:boolean;citations:ChatSource[];feedback:string|null};
