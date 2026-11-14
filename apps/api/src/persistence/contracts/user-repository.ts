import type { UserSecretsRepository } from "./user-secrets";

export type CurrentUser = {
  id: string;
  username: string;
  email: string;
  is_admin: boolean;
  video_count: number;
  max_video_upload_size_mb: number;
  used_upload_bytes: number;
  monthly_upload_limit_bytes: number | null;
  upload_resets_at: string;
  used_storage_bytes: number;
  storage_limit_bytes: number | null;
  used_processing_seconds: number;
  processing_limit_seconds: number | null;
  used_ai_answers: number;
  ai_answers_limit: number | null;
  is_over_quota: boolean;
  plan_code: "free" | "basic" | "pro";
  subscription_status: string | null;
  quota_source: "plan" | "admin";
};

export interface UserRepository extends UserSecretsRepository {
  getCurrentUser(userId: string): Promise<CurrentUser | null>;
}
