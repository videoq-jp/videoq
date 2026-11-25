import { z } from "zod";

const userId = z.object({ id: z.string().min(1) });
// Quota and monthly usage counters use PostgreSQL integer columns.
const nonNegativeInt32 = z.number().int().nonnegative().max(2_147_483_647);

const recoveryJob = z.object({ job: z.unknown() }).strict();
export const adminInputSchemas = {
  'admin.inspectSearchRecovery': recoveryJob,
  'admin.restartSearchWorkflow': recoveryJob.extend({inspection:z.string().regex(/^[a-f0-9]{64}$/)}),
  "admin.createUser": z.object({
    email: z.email().max(254), username: z.string().trim().min(3).max(150).regex(/^[a-zA-Z0-9_.]+$/),
  }).strict(),
  "admin.resetAccess": userId,
  "admin.listUsers": z.object({
    q: z.string().optional(),
    limit: z.number().int().positive().max(100).default(100),
    offset: z.number().int().nonnegative().default(0),
  }).default({ limit: 100, offset: 0 }),
  "admin.getUser": userId,
  "admin.patchQuota": userId.extend({
    monthly_upload_limit_gb: z.number().nonnegative().nullable().optional(),
    storage_limit_gb: z.number().nonnegative().nullable().optional(),
    processing_limit_minutes: nonNegativeInt32.nullable().optional(),
    ai_answers_limit: nonNegativeInt32.nullable().optional(),
    quota_source: z.enum(["plan", "admin"]).optional(),
  }),
  "admin.patchUsage": userId.extend({
    used_storage_bytes: z.number().int().nonnegative().optional(),
    used_processing_seconds: nonNegativeInt32.optional(),
    used_ai_answers: nonNegativeInt32.optional(),
    usage_period_start: z.iso.datetime({ offset: true }).nullable().optional(),
    is_over_quota: z.boolean().optional(),
  }),
  "admin.patchFlags": userId.extend({
    is_active: z.boolean().optional(),
    is_admin: z.boolean().optional(),
  }).strict(),
  "admin.deleteUser": userId,
  "admin.reindexAll": z.undefined(),
};
