// SQLite / D1 schema. PostgreSQL history is maintained independently.
import { sqliteTable, text, integer, real, index, uniqueIndex, foreignKey, check, unique, primaryKey } from "drizzle-orm/sqlite-core";
import { sql, asc, desc } from "drizzle-orm";
import { isoDate } from "./columns";
// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------
/** Short-lived LTI login proofs and course-scoped sessions; secrets are hashed. */
export const ltiCredentials = sqliteTable("lti_credentials", {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    expiresAt: isoDate("expires_at").notNull(),
}, (table) => [index("lti_credentials_expiry_idx").on(table.expiresAt)]);
/** Shared sliding windows for the on-prem Node runtime. Workers keep using DOs. */
export const runtimeRateLimits = sqliteTable("runtime_rate_limits", {
    key: text("key").primaryKey(),
    history: text("history", { mode: "json" }).$type<number[]>().notNull().default([]),
    windowSec: integer("window_sec").notNull(),
    expiresAt: isoDate("expires_at").notNull(),
}, (table) => [index("runtime_rate_limits_expiry_idx").on(table.expiresAt)]);
export const users = sqliteTable("users", {
    /** Better Auth default: string UUID (text PK). */
    id: text("id").primaryKey(),
    /** Better Auth display name (required by BA). */
    name: text("name").notNull().default(""),
    email: text().notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    /** Better Auth writes JS Date (`type: "date"`). */
    createdAt: isoDate("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoDate("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    username: text().notNull(),
    displayUsername: text("display_username"),
    /** Better Auth admin plugin role (`admin` | `user`). */
    role: text("role").notNull().default("user"),
    banned: integer("banned", { mode: "boolean" }).default(false),
    banReason: text("ban_reason"),
    banExpires: isoDate("ban_expires"),
    /** App-owned timestamps; written as ISO strings / SQL `now()`, not by Better Auth. */
    lastLogin: text("last_login"),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    /** Historical migration columns; runtime authorization uses `role` + `banned`. */
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    dateJoined: text("date_joined").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    deactivatedAt: text("deactivated_at"),
    /** Legacy column retained for rolling deploys; no longer an admission limit. */
    maxVideoUploadSizeMb: integer("max_video_upload_size_mb").notNull().default(0),
    searchapiApiKeyEncrypted: text("searchapi_api_key_encrypted"),
    aiAnswersLimit: integer("ai_answers_limit"),
    isOverQuota: integer("is_over_quota", { mode: "boolean" }).notNull(),
    processingLimitMinutes: integer("processing_limit_minutes"),
    storageLimitGb: real("storage_limit_gb"),
    monthlyUploadLimitGb: real("monthly_upload_limit_gb").default(2),
    usedUploadBytes: integer("used_upload_bytes").notNull().default(0),
    uploadUsagePeriodStart: text("upload_usage_period_start"),
    usagePeriodStart: text("usage_period_start"),
    usedAiAnswers: integer("used_ai_answers").notNull(),
    usedProcessingSeconds: integer("used_processing_seconds").notNull(),
    usedStorageBytes: integer("used_storage_bytes").notNull(),
    pendingEmail: text("pending_email"),
    passwordResetRequired: integer("password_reset_required", { mode: "boolean" }).notNull().default(true),
    /** Monotonic CAS token; maintained by the users billing revision trigger. */
    billingRevision: integer("billing_revision").notNull().default(0),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    planCode: text("plan_code").notNull().default("free"),
    subscriptionStatus: text("subscription_status"),
    quotaSource: text("quota_source").notNull().default("plan"),
}, (table) => [
    index("users_email_active_idx").on(asc(table.email), asc(table.isActive)),
    index("users_deactivated_at_idx").on(asc(table.deactivatedAt)),
    index("users_stripe_customer_id_idx").on(asc(table.stripeCustomerId)),
    unique("users_username_key").on(table.username),
    unique("users_email_key").on(table.email),
    unique("users_stripe_customer_id_key").on(table.stripeCustomerId),
    unique("users_stripe_subscription_id_key").on(table.stripeSubscriptionId),
    check("users_max_video_upload_size_mb_check", sql `max_video_upload_size_mb >= 0`),
    check("users_monthly_upload_limit_check", sql `monthly_upload_limit_gb >= 0`),
    check("users_used_upload_bytes_check", sql `used_upload_bytes >= 0`),
    check("users_plan_code_check", sql `plan_code IN ('free', 'basic', 'pro')`),
    check("users_quota_source_check", sql `quota_source IN ('plan', 'admin')`),
]);
export const accountDeletionRequests = sqliteTable("account_deletion_requests", {
    id: integer().primaryKey({ autoIncrement: true }),
    reason: text().notNull(),
    requestedAt: text("requested_at").notNull(),
    userId: text("user_id").notNull(),
}, (table) => [
    index("account_deletion_requests_user_id_idx").on(asc(table.userId)),
    index("account_deletion_requests_user_requested_idx").on(asc(table.userId), desc(table.requestedAt)),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "account_deletion_requests_user_id_fkey",
    }).onDelete("cascade"),
]);
// ---------------------------------------------------------------------------
// Durable delivery / cleanup outbox
// ---------------------------------------------------------------------------
export const externalTasks = sqliteTable("external_tasks", {
    id: integer().primaryKey({ autoIncrement: true }),
    kind: text().notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    attempts: integer().notNull().default(0),
    availableAt: text("available_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    lockedAt: text("locked_at"),
    completedAt: text("completed_at"),
    deadAt: text("dead_at"),
    effectAppliedAt: text("effect_applied_at"),
    lastError: text("last_error").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    unique("external_tasks_dedupe_key_key").on(table.dedupeKey),
    index('external_tasks_video_job_idx').on(sql `(${table.payload} ->> '$.message.payload.video_id')`, table.createdAt)
        .where(sql `${table.kind} = 'sqs_job'`),
    index("external_tasks_ready_idx")
        .on(table.availableAt, table.id)
        .where(sql `completed_at IS NULL AND dead_at IS NULL`),
    index("external_tasks_completed_idx")
        .on(table.completedAt, table.id)
        .where(sql `completed_at IS NOT NULL`),
    check("external_tasks_kind_check", sql `kind IN ('sqs_job', 'storage_cleanup', 'invitation_email', 'multipart_abort', 'multipart_cleanup')`),
    check("external_tasks_attempts_check", sql `attempts >= 0`),
]);
/** SQS/Lambda の at-least-once 配送を job_id 単位で一度だけclaimする台帳。 */
export const jobExecutions = sqliteTable("job_executions", {
    jobId: text("job_id").primaryKey(),
    jobType: text("job_type").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    status: text().notNull(),
    attempts: integer().notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: text("lease_until"),
    completedAt: text("completed_at"),
    lastError: text("last_error").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    index("job_executions_completed_idx")
        .on(table.completedAt, table.jobId)
        .where(sql `completed_at IS NOT NULL`),
    check("job_executions_status_check", sql `status IN ('running', 'failed', 'completed')`),
    check("job_executions_attempts_check", sql `attempts >= 0`),
]);
/**
 * MCP の作成系ツールを at-most-once にする台帳。
 *
 * resourceId は action ごとに videos / video_courses の id を指す。対象作成と
 * 同じ transaction で記録し、同じ user/action/key の再試行では既存 id を返す。
 */
export const mcpIdempotencyRecords = sqliteTable("mcp_idempotency_records", {
    userId: text("user_id").notNull(),
    action: text().notNull(),
    key: text().notNull(),
    requestHash: text("request_hash").notNull(),
    resourceId: integer("resource_id").notNull(),
    createdAt: text("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    primaryKey({
        name: "mcp_idempotency_records_pkey",
        columns: [table.userId, table.action, table.key],
    }),
    index("mcp_idempotency_records_created_at_idx").on(table.createdAt),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "mcp_idempotency_records_user_id_fkey",
    }).onDelete("cascade"),
    check("mcp_idempotency_records_action_check", sql `action IN ('request_video_upload', 'create_youtube_video', 'create_course')`),
    check("mcp_idempotency_records_request_hash_check", sql `(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*')`),
]);
// ---------------------------------------------------------------------------
// Videos, courses, tags
// ---------------------------------------------------------------------------
// Business records retain the NO ACTION user references established by 0006.
// The deletion worker removes media and dependent records before the user row.
export const videos = sqliteTable("videos", {
    /** Keep source authority after a connection or mapping is removed. */
    managedByLms: integer("managed_by_lms", { mode: "boolean" }).notNull().default(false),
    id: integer().primaryKey({ autoIncrement: true }),
    transcriptionLanguage: text("transcription_language"),
    file: text().notNull(),
    multipartUpload: text("multipart_upload", { mode: "json" }).$type<{
        uploadId: string;
        partSize: number;
        contentType: string;
    }>(),
    uploadHeartbeatAt: text("upload_heartbeat_at"),
    /** Month of admission, also used to refund an unconfirmed upload exactly once. */
    uploadUsagePeriodStart: text("upload_usage_period_start"),
    title: text().notNull(),
    description: text().notNull(),
    uploadedAt: text("uploaded_at").notNull(),
    transcript: text().notNull(),
    status: text().notNull(),
    errorMessage: text("error_message").notNull(),
    processingSeconds: integer("processing_seconds").notNull().default(0),
    userId: text("user_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url").notNull(),
    youtubeVideoId: text("youtube_video_id").notNull(),
}, (table) => [
    index("videos_user_id_idx").on(asc(table.userId)),
    index("videos_status_idx").on(asc(table.status)),
    index("videos_uploaded_at_idx").on(asc(table.uploadedAt)),
    index("videos_user_status_uploaded_idx").on(asc(table.userId), asc(table.status), desc(table.uploadedAt)),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "videos_user_id_fkey",
    }).onDelete("no action"),
    check("videos_processing_seconds_check", sql `processing_seconds >= 0`),
]);
/** Durable per-video plan and checkpoints for bounded transcription jobs. */
export const videoTranscriptionRuns = sqliteTable("video_transcription_runs", {
    videoId: integer("video_id").primaryKey().references(() => videos.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().unique(),
    fileKey: text("file_key").notNull(),
    transcriptHash: text("transcript_hash").notNull(),
    durationMs: integer("duration_ms").notNull(),
    chunkSeconds: integer("chunk_seconds").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    check("video_transcription_runs_duration_check", sql `${table.durationMs} > 0`),
    check("video_transcription_runs_chunks_check", sql `${table.chunkSeconds} > 0 AND ${table.chunkCount} BETWEEN 1 AND 10000`),
]);
export const videoTranscriptionChunks = sqliteTable("video_transcription_chunks", {
    runId: text("run_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    segments: text({ mode: "json" }).$type<{
        start: number;
        end: number;
        text: string;
    }[]>(),
    fallbackSegments: text("fallback_segments", { mode: "json" }).$type<Record<string, {
        start: number;
        end: number;
        text: string;
    }[]>>().notNull().default({}),
    failures: integer().notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    primaryKey({ columns: [table.runId, table.chunkIndex] }),
    foreignKey({ columns: [table.runId], foreignColumns: [videoTranscriptionRuns.runId], name: "video_transcription_chunks_run_id_fkey" }).onDelete("cascade"),
    check("video_transcription_chunks_index_check", sql `${table.chunkIndex} >= 0`),
    check("video_transcription_chunks_failures_check", sql `${table.failures} >= 0`),
]);
export const videoVisualRuns = sqliteTable("video_visual_runs", {
    publicationVersion: text("publication_version"),
    videoId: integer("video_id").primaryKey().references(() => videos.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().unique(),
    fileKey: text("file_key").notNull(),
    durationMs: integer("duration_ms").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    status: text().notNull().default("processing"),
    lastError: text("last_error").notNull().default(""),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    check("video_visual_runs_duration_check", sql `${table.durationMs} > 0 AND ${table.durationMs} <= 36000000`),
    check("video_visual_runs_chunks_check", sql `${table.chunkCount} BETWEEN 1 AND 600`),
    check("video_visual_runs_status_check", sql `${table.status} IN ('processing', 'ready', 'error')`),
]);
export const videoVisualChunks = sqliteTable("video_visual_chunks", {
    runId: text("run_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    objectVersion: text("object_version"),
    frameCount: integer("frame_count"),
    failures: integer().notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    primaryKey({ columns: [table.runId, table.chunkIndex] }),
    foreignKey({ columns: [table.runId], foreignColumns: [videoVisualRuns.runId], name: "video_visual_chunks_run_id_fkey" }).onDelete("cascade"),
    check("video_visual_chunks_index_check", sql `${table.chunkIndex} BETWEEN 0 AND 599`),
    check("video_visual_chunks_frames_check", sql `${table.frameCount} IS NULL OR ${table.frameCount} BETWEEN 0 AND 60`),
    check("video_visual_chunks_failures_check", sql `${table.failures} >= 0`),
]);
export const videoCourses = sqliteTable("video_courses", {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    description: text().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id").notNull(),
    shareSlug: text("share_slug"),
    managedByLms: integer("managed_by_lms", { mode: "boolean" }).notNull().default(false),
    /** Also persists for legacy native courses that contained LMS materials. */
    nativeAccessDisabled: integer("native_access_disabled", { mode: "boolean" }).notNull().default(false),
    displayOrder: integer("display_order").notNull(),
}, (table) => [
    index("video_courses_user_id_idx").on(asc(table.userId)),
    index("video_courses_share_slug_idx").on(asc(table.shareSlug)).where(sql `(share_slug IS NOT NULL)`),
    uniqueIndex("video_courses_share_slug_ci_uniq").on(sql `lower((share_slug))`).where(sql `(share_slug IS NOT NULL)`),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "video_courses_user_id_fkey",
    }).onDelete("no action"),
]);
export const videoCourseMembers = sqliteTable("video_course_members", {
    id: integer().primaryKey({ autoIncrement: true }),
    addedAt: text("added_at").notNull(),
    order: integer().notNull(),
    courseId: integer("course_id").notNull(),
    videoId: integer("video_id").notNull(),
}, (table) => [
    index("video_course_members_course_id_idx").on(asc(table.courseId)),
    index("video_course_members_video_id_idx").on(asc(table.videoId)),
    index("video_course_members_course_order_idx").on(asc(table.courseId), asc(table.order)),
    foreignKey({
        columns: [table.courseId],
        foreignColumns: [videoCourses.id],
        name: "video_course_members_course_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.videoId],
        foreignColumns: [videos.id],
        name: "video_course_members_video_id_fkey",
    }).onDelete("cascade"),
    unique("video_course_members_course_video_uniq").on(table.courseId, table.videoId),
]);
/** Email-bound invitations for user membership in a video course. */
export const videoCourseInvitations = sqliteTable("video_course_invitations", {
    /** Adapter-local batch marker; cleared before the creation batch commits. */
    creationNonce: text("creation_nonce"),
    id: integer().primaryKey({ autoIncrement: true }),
    courseId: integer("course_id").notNull(),
    email: text().notNull(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    status: text().notNull().default("pending"),
    deliveryStatus: text("delivery_status").notNull().default("queued"),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    acceptedByUserId: text("accepted_by_user_id"),
    acceptedAt: text("accepted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastSentAt: text("last_sent_at"),
    sendAttempts: integer("send_attempts").notNull().default(0),
    lastError: text("last_error"),
}, (table) => [
    index("video_course_invitations_creation_nonce_idx").on(table.creationNonce).where(sql `creation_nonce IS NOT NULL`),
    index("video_course_invitations_course_status_idx").on(asc(table.courseId), asc(table.status)),
    index("video_course_invitations_email_idx").on(asc(table.email)),
    unique("video_course_invitations_token_hash_key").on(table.tokenHash),
    uniqueIndex("video_course_invitations_pending_email_uniq")
        .on(table.courseId, table.email)
        .where(sql `status = 'pending'`),
    foreignKey({
        columns: [table.courseId],
        foreignColumns: [videoCourses.id],
        name: "video_course_invitations_course_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.invitedByUserId],
        foreignColumns: [users.id],
        name: "video_course_invitations_invited_by_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.acceptedByUserId],
        foreignColumns: [users.id],
        name: "video_course_invitations_accepted_by_user_id_fkey",
    }).onDelete("set null"),
    check("video_course_invitations_status_check", sql `status IN ('pending', 'accepted', 'declined', 'expired', 'revoked')`),
    check("video_course_invitations_delivery_status_check", sql `delivery_status IN ('queued', 'sent', 'failed')`),
    check("video_course_invitations_send_attempts_check", sql `send_attempts >= 0`),
]);
/** Accepted user memberships. Owners are represented by video_courses.user_id, not here. */
export const videoCourseMemberships = sqliteTable("video_course_memberships", {
    id: integer().primaryKey({ autoIncrement: true }),
    courseId: integer("course_id").notNull(),
    userId: text("user_id").notNull(),
    invitationId: integer("invitation_id"),
    joinedAt: text("joined_at").notNull(),
}, (table) => [
    index("video_course_memberships_course_id_idx").on(asc(table.courseId)),
    index("video_course_memberships_user_id_idx").on(asc(table.userId)),
    unique("video_course_memberships_course_user_uniq").on(table.courseId, table.userId),
    unique("video_course_memberships_invitation_id_key").on(table.invitationId),
    foreignKey({
        columns: [table.courseId],
        foreignColumns: [videoCourses.id],
        name: "video_course_memberships_course_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "video_course_memberships_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.invitationId],
        foreignColumns: [videoCourseInvitations.id],
        name: "video_course_memberships_invitation_id_fkey",
    }).onDelete("set null"),
]);
export const tags = sqliteTable("tags", {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    color: text().notNull(),
    createdAt: text("created_at").notNull(),
    userId: text("user_id").notNull(),
}, (table) => [
    index("tags_user_id_idx").on(asc(table.userId)),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "tags_user_id_fkey",
    }).onDelete("no action"),
    unique("tags_user_id_name_uniq").on(table.name, table.userId),
]);
export const videoTags = sqliteTable("video_tags", {
    id: integer().primaryKey({ autoIncrement: true }),
    addedAt: text("added_at").notNull(),
    tagId: integer("tag_id").notNull(),
    videoId: integer("video_id").notNull(),
}, (table) => [
    index("video_tags_tag_id_idx").on(asc(table.tagId)),
    index("video_tags_video_id_idx").on(asc(table.videoId)),
    foreignKey({
        columns: [table.tagId],
        foreignColumns: [tags.id],
        name: "video_tags_tag_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.videoId],
        foreignColumns: [videos.id],
        name: "video_tags_video_id_fkey",
    }).onDelete("cascade"),
    unique("video_tags_video_tag_uniq").on(table.tagId, table.videoId),
]);
// ---------------------------------------------------------------------------
// Chat and archived evaluation records
// ---------------------------------------------------------------------------
export const chatLogs = sqliteTable("chat_logs", {
    id: integer().primaryKey({ autoIncrement: true }),
    question: text().notNull(),
    response: text({ mode: "json" }).$type<import("@videoq/trpc/chat").ChatAnswer>().notNull(),
    isSharedOrigin: integer("is_shared_origin", { mode: "boolean" }).notNull(),
    feedback: text(),
    createdAt: text("created_at").notNull(),
    userId: text("user_id").notNull(),
    courseId: integer("course_id").notNull(),
    retrievedContexts: text("retrieved_contexts", { mode: "json" }).notNull(),
}, (table) => [
    index("chat_logs_user_id_idx").on(asc(table.userId)),
    index("chat_logs_course_id_idx").on(asc(table.courseId)),
    index("chat_logs_course_created_idx").on(asc(table.courseId), desc(table.createdAt)),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "chat_logs_user_id_fkey",
    }).onDelete("no action"),
    foreignKey({
        columns: [table.courseId],
        foreignColumns: [videoCourses.id],
        name: "chat_logs_course_id_fkey",
    }).onDelete("cascade"),
]);
/** Anonymous cost ledger: no user ID, prompt, response, or provider credential. */
export const aiAnswerAttempts = sqliteTable("ai_answer_attempts", {
    id: text().primaryKey(),
    startedAt: isoDate("started_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    finishedAt: isoDate("finished_at"),
    planCode: text("plan_code").notNull(),
    quotaSource: text("quota_source").notNull(),
    hasCourse: integer("has_course", { mode: "boolean" }).notNull(),
    streamed: integer({ mode: "boolean" }).notNull(),
    status: text().notNull(),
    quotaConsumed: integer("quota_consumed", { mode: "boolean" }),
    providerCalls: text("provider_calls", { mode: "json" }).$type<Record<string, unknown>[]>().notNull().default([]),
}, (table) => [
    index("ai_answer_attempts_started_idx").on(table.startedAt),
    check("ai_answer_attempts_status_check", sql `status IN ('started', 'completed', 'failed', 'interrupted')`),
]);
// Retained for historical data only; automated evaluation was retired.
export const chatLogEvaluations = sqliteTable("chat_log_evaluations", {
    id: integer().primaryKey({ autoIncrement: true }),
    status: text().notNull(),
    faithfulness: real(),
    answerRelevancy: real("answer_relevancy"),
    contextPrecision: real("context_precision"),
    errorMessage: text("error_message").notNull(),
    evaluatedAt: text("evaluated_at"),
    createdAt: text("created_at").notNull(),
    chatLogId: integer("chat_log_id").notNull(),
}, (table) => [
    index("chat_log_evaluations_status_idx").on(asc(table.status)),
    foreignKey({
        columns: [table.chatLogId],
        foreignColumns: [chatLogs.id],
        name: "chat_log_evaluations_chat_log_id_fkey",
    }).onDelete("cascade"),
    unique("chat_log_evaluations_chat_log_id_key").on(table.chatLogId),
]);
export const courseEvaluationSnapshots = sqliteTable("course_evaluation_snapshots", {
    id: integer().primaryKey({ autoIncrement: true }),
    sampleCount: integer("sample_count").notNull(),
    faithfulnessMean: real("faithfulness_mean"),
    answerRelevancyMean: real("answer_relevancy_mean"),
    samples: text({ mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    courseId: integer("course_id").notNull(),
    userId: text("user_id").notNull(),
    contextPrecisionMean: real("context_precision_mean"),
}, (table) => [
    index("course_evaluation_snapshots_user_id_idx").on(asc(table.userId)),
    foreignKey({
        columns: [table.courseId],
        foreignColumns: [videoCourses.id],
        name: "course_evaluation_snapshots_course_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "course_evaluation_snapshots_user_id_fkey",
    }).onDelete("no action"),
    unique("course_evaluation_snapshots_course_id_key").on(table.courseId),
]);
// ---------------------------------------------------------------------------
// Vector embeddings
// ---------------------------------------------------------------------------
export const stripeEvents = sqliteTable("stripe_events", {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    processedAt: text("processed_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});
/** Application ownership/retention; checkpoint payloads are owned by LangGraph. */
export const chatConversations = sqliteTable("chat_conversations", {
    threadId: text("thread_id").primaryKey(),
    conversationId: text("conversation_id").notNull().$defaultFn(() => crypto.randomUUID()),
    scopeKey: text("scope_key"),
    title: text("title").notNull().default(""),
    createdAt: isoDate("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoDate("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    committedCheckpointId: text("committed_checkpoint_id"),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "cascade" }),
    courseId: integer("course_id").references(() => videoCourses.id, { onDelete: "cascade" }),
    leaseId: text("lease_id"),
    leasedUntil: isoDate("leased_until"),
    expiresAt: isoDate("expires_at").notNull(),
}, table => [index("chat_conversations_expiry_idx").on(table.expiresAt), index("chat_conversations_course_idx").on(table.courseId), index("chat_conversations_scope_updated_idx").on(table.scopeKey, table.updatedAt)]);
/** Original transcript for the UI; model context is compacted independently. */
export const chatConversationTurns = sqliteTable("chat_conversation_turns", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: text("thread_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    question: text("question").notNull(),
    response: text("response", { mode: "json" }).$type<import("@videoq/trpc/chat").ChatAnswer>().notNull(),
    chatLogId: integer("chat_log_id").references(() => chatLogs.id, { onDelete: "set null" }),
    createdAt: isoDate("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [foreignKey({ columns: [table.threadId], foreignColumns: [chatConversations.threadId], name: "chat_conversation_turns_thread_fk" }).onDelete("cascade"), uniqueIndex("chat_conversation_turns_checkpoint_idx").on(table.threadId, table.checkpointId), index("chat_conversation_turns_thread_idx").on(table.threadId, table.id)]);
/** Server-verified Moodle attribution, written atomically with the answer log. */
export const ltiChatLogSubjects = sqliteTable('lti_chat_log_subjects', {
    chatLogId: integer('chat_log_id').primaryKey().references(() => chatLogs.id, { onDelete: 'cascade' }),
    subjectKey: text('subject_key').notNull(),
    resourceVideoIds: text('resource_video_ids', { mode: "json" }).$type<number[]>().notNull(),
    // Snapshot from a verified Classroom login, retained with its question log.
    classroomAuthor: text('classroom_author', { mode: 'json' }).$type<{ user_id: string; username: string; email: string }>(),
    // Only verified stored sessions populate reporting provenance. Older records
    // remain unattributed; an owner/course match cannot identify an installation.
    registrationId: text('registration_id'),
    contextId: text('context_id'),
}, table => [index('lti_chat_log_subjects_subject_idx').on(table.subjectKey, table.chatLogId),
    index('lti_chat_log_subjects_report_idx').on(table.registrationId, table.contextId, table.chatLogId),
    check('lti_chat_log_subjects_key_format', sql `(length(${table.subjectKey}) = 64 AND ${table.subjectKey} NOT GLOB '*[^a-f0-9]*')`),
    check('lti_chat_log_subjects_resources_array', sql `json_type(${table.resourceVideoIds}) = 'array'`)]);
/** Original resource scope survives later visibility changes and source deletion. */
export const ltiConversationScopes = sqliteTable('lti_conversation_scopes', {
    threadId: text('thread_id').primaryKey(),
    subjectKey: text('subject_key').notNull(),
    resourceVideoIds: text('resource_video_ids', { mode: "json" }).$type<number[]>().notNull(),
}, table => [foreignKey({ columns: [table.threadId], foreignColumns: [chatConversations.threadId], name: 'lti_conversation_scopes_thread_fk' }).onDelete('cascade'),
    index('lti_conversation_scopes_subject_idx').on(table.subjectKey, table.threadId),
    check('lti_conversation_scopes_key_format', sql `(length(${table.subjectKey}) = 64 AND ${table.subjectKey} NOT GLOB '*[^a-f0-9]*')`),
    check('lti_conversation_scopes_resources_array', sql `json_type(${table.resourceVideoIds}) = 'array'`)]);
// Explicitly published course Q&A; private AI chat logs are never included.
export const courseQuestions = sqliteTable('course_questions', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    courseId: integer('course_id').notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
    videoId: integer('video_id').references(() => videos.id, { onDelete: 'set null' }),
    // Retained after source deletion so a restricted thread cannot become course-wide.
    sourceVideoId: integer('source_video_id'),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    ltiAuthorId: text('lti_author_id'),
    ltiInstructor: integer('lti_instructor', { mode: "boolean" }).notNull().default(false),
    title: text('title').notNull(),
    body: text('body').notNull(),
    featured: integer('featured', { mode: "boolean" }).notNull().default(false),
    createdAt: isoDate('created_at').notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoDate('updated_at').notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [
    index('course_questions_course_created_idx').on(table.courseId, table.createdAt),
    index('course_questions_video_idx').on(table.courseId, table.videoId),
    index('course_questions_lti_author_idx').on(table.ltiAuthorId, table.courseId),
    check('course_questions_body_length', sql `length(${table.body}) BETWEEN 1 AND 10000`),
    check('course_questions_author_kind', sql `${table.authorId} IS NULL OR ${table.ltiAuthorId} IS NULL`),
    check('course_questions_lti_author_format', sql `${table.ltiAuthorId} IS NULL OR (length(${table.ltiAuthorId}) = 64 AND ${table.ltiAuthorId} NOT GLOB '*[^a-f0-9]*')`),
    check('course_questions_source_positive', sql `${table.sourceVideoId} IS NULL OR ${table.sourceVideoId} > 0`),
]);
export const courseQuestionReplies = sqliteTable('course_question_replies', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    questionId: text('question_id').notNull().references(() => courseQuestions.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    ltiAuthorId: text('lti_author_id'),
    ltiInstructor: integer('lti_instructor', { mode: "boolean" }).notNull().default(false),
    body: text('body').notNull(),
    createdAt: isoDate('created_at').notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: isoDate('updated_at').notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [index('course_question_replies_question_idx').on(table.questionId, table.createdAt),
    check('course_question_replies_body_length', sql `length(${table.body}) BETWEEN 1 AND 10000`),
    index('course_question_replies_lti_author_idx').on(table.ltiAuthorId),
    check('course_question_replies_author_kind', sql `${table.authorId} IS NULL OR ${table.ltiAuthorId} IS NULL`),
    check('course_question_replies_lti_author_format', sql `${table.ltiAuthorId} IS NULL OR (length(${table.ltiAuthorId}) = 64 AND ${table.ltiAuthorId} NOT GLOB '*[^a-f0-9]*')`)]);
export const courseQuestionVotes = sqliteTable('course_question_votes', {
    questionId: text('question_id').notNull().references(() => courseQuestions.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, table => [primaryKey({ columns: [table.questionId, table.userId] })]);
export const courseQuestionLtiVotes = sqliteTable('course_question_lti_votes', {
    questionId: text('question_id').notNull().references(() => courseQuestions.id, { onDelete: 'cascade' }),
    ltiAuthorId: text('lti_author_id').notNull(),
    createdAt: isoDate('created_at').notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [primaryKey({ columns: [table.questionId, table.ltiAuthorId] }),
    index('course_question_lti_votes_author_idx').on(table.ltiAuthorId),
    check('course_question_lti_votes_author_format', sql `(length(${table.ltiAuthorId}) = 64 AND ${table.ltiAuthorId} NOT GLOB '*[^a-f0-9]*')`)]);
// Moderation records contain identifiers/actions, never a second copy of post text.
export const courseQaModeration = sqliteTable('course_qa_moderation', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    courseId: integer('course_id').notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
    questionId: text('question_id').notNull(),
    replyId: text('reply_id'),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    ltiActorId: text('lti_actor_id'),
    action: text('action').notNull(),
    createdAt: isoDate('created_at').notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [index('course_qa_moderation_course_idx').on(table.courseId, table.createdAt),
    index('course_qa_moderation_lti_actor_idx').on(table.ltiActorId),
    index('course_qa_moderation_retention_idx').on(table.createdAt, table.id).where(sql `${table.ltiActorId} IS NOT NULL`),
    check('course_qa_moderation_actor_kind', sql `${table.actorUserId} IS NULL OR ${table.ltiActorId} IS NULL`),
    check('course_qa_moderation_lti_actor_format', sql `${table.ltiActorId} IS NULL OR (length(${table.ltiActorId}) = 64 AND ${table.ltiActorId} NOT GLOB '*[^a-f0-9]*')`),
    check('course_qa_moderation_action', sql `${table.action} IN ('feature', 'unfeature', 'delete_question', 'delete_reply')`)]);
