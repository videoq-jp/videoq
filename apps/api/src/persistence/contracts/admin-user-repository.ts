import type { RpcInputMap } from "@videoq/trpc";
export type AdminUser = {
  id: string;
  username: string;
  email: string;
  is_active: boolean;
  is_admin: boolean;
  max_video_upload_size_mb: number;
  storage_limit_gb: number | null;
  monthly_upload_limit_gb: number | null;
  processing_limit_minutes: number | null;
  ai_answers_limit: number | null;
  used_storage_bytes: number;
  used_processing_seconds: number;
  used_ai_answers: number;
  usage_period_start: string | null;
  is_over_quota: boolean;
  plan_code: string;
  quota_source: "plan" | "admin";
};

export type AdminQuotaPatch = Omit<RpcInputMap["admin.patchQuota"], "id">;
export type AdminUsagePatch = Omit<RpcInputMap["admin.patchUsage"], "id">;
export type AdminDeleteResult = {notFound:true}|{forbiddenAdmin:true}|{taskId:number;jobId:string};
export type AdminFlagsPatch = Omit<RpcInputMap["admin.patchFlags"], "id">;
export interface AdminUserRepository {
  patchFlags(actorId:string,targetId:string,patch:AdminFlagsPatch,headers:Headers):Promise<AdminUser|null>;
  lockForHardDelete(userId:string):Promise<AdminDeleteResult>;
  isAdmin(userId:string):Promise<boolean>;
  list(query:string,limit:number,offset:number):Promise<{count:number;results:AdminUser[]}>;
  find(userId:string):Promise<AdminUser|null>;
  patchQuota(userId:string,patch:AdminQuotaPatch):Promise<AdminUser|null>;
  patchUsage(userId:string,patch:AdminUsagePatch):Promise<AdminUser|null>;
}
