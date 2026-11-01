import { EMBEDDING_DIMENSIONS } from "../../lib/embedding-dimensions";
import {
	pgTable,
	bigint,
	varchar,
	timestamp,
	unique,
	integer,
	index,
	foreignKey,
	check,
	text,
	jsonb,
	boolean,
	uniqueIndex,
	uuid,
	vector,
	json,
	doublePrecision,
	primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

/** Shared sliding windows for the on-prem Node runtime. Workers keep using DOs. */
export const runtimeRateLimits = pgTable("runtime_rate_limits", {
	key: text("key").primaryKey(),
	history: jsonb("history").$type<number[]>().notNull().default([]),
	windowSec: integer("window_sec").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("runtime_rate_limits_expiry_idx").on(table.expiresAt)]);

export const users = pgTable(
	"users",
	{
		/** Better Auth default: string UUID (text PK). */
		id: text("id").primaryKey(),
		/** Better Auth display name (required by BA). */
		name: text("name").notNull().default(""),
		email: varchar({ length: 254 }).notNull(),
		emailVerified: boolean("email_verified").notNull().default(false),
		image: text("image"),
		/** Better Auth writes JS Date (`type: "date"`). */
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		username: varchar({ length: 150 }).notNull(),
		displayUsername: text("display_username"),
		/** Better Auth admin plugin role (`admin` | `user`). */
		role: text("role").notNull().default("user"),
		banned: boolean("banned").default(false),
		banReason: text("ban_reason"),
		banExpires: timestamp("ban_expires", { withTimezone: true }),
		/** App-owned timestamps; written as ISO strings / SQL `now()`, not by Better Auth. */
		lastLogin: timestamp("last_login", { withTimezone: true, mode: "string" }),
		firstName: varchar("first_name", { length: 150 }).notNull().default(""),
		lastName: varchar("last_name", { length: 150 }).notNull().default(""),
		/** Historical migration columns; runtime authorization uses `role` + `banned`. */
		isActive: boolean("is_active").notNull().default(true),
		dateJoined: timestamp("date_joined", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
		deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "string" }),
		/** Legacy column retained for rolling deploys; no longer an admission limit. */
		maxVideoUploadSizeMb: integer("max_video_upload_size_mb").notNull().default(0),
		searchapiApiKeyEncrypted: text("searchapi_api_key_encrypted"),
		aiAnswersLimit: integer("ai_answers_limit"),
		isOverQuota: boolean("is_over_quota").notNull(),
		processingLimitMinutes: integer("processing_limit_minutes"),
		storageLimitGb: doublePrecision("storage_limit_gb"),
		monthlyUploadLimitGb: doublePrecision("monthly_upload_limit_gb").default(2),
		usedUploadBytes: bigint("used_upload_bytes", { mode: "number" }).notNull().default(0),
		uploadUsagePeriodStart: timestamp("upload_usage_period_start", { withTimezone: true, mode: "string" }),
		usagePeriodStart: timestamp("usage_period_start", { withTimezone: true, mode: "string" }),
		usedAiAnswers: integer("used_ai_answers").notNull(),
		usedProcessingSeconds: integer("used_processing_seconds").notNull(),
		usedStorageBytes: bigint("used_storage_bytes", { mode: "number" }).notNull(),
		pendingEmail: varchar("pending_email", { length: 254 }),
		passwordResetRequired: boolean("password_reset_required").notNull().default(true),
		stripeCustomerId: text("stripe_customer_id"),
		stripeSubscriptionId: text("stripe_subscription_id"),
		planCode: text("plan_code").notNull().default("free"),
		subscriptionStatus: text("subscription_status"),
		quotaSource: text("quota_source").notNull().default("plan"),
	},
	(table) => [
		index("users_email_active_idx").using(
			"btree",
			table.email.asc().nullsLast(),
			table.isActive.asc().nullsLast(),
		),
		index("users_deactivated_at_idx").using("btree", table.deactivatedAt.asc().nullsLast()),
		index("users_stripe_customer_id_idx").using(
			"btree",
			table.stripeCustomerId.asc().nullsLast(),
		),
		unique("users_username_key").on(table.username),
		unique("users_email_key").on(table.email),
		unique("users_stripe_customer_id_key").on(table.stripeCustomerId),
		unique("users_stripe_subscription_id_key").on(table.stripeSubscriptionId),
		check("users_max_video_upload_size_mb_check", sql`max_video_upload_size_mb >= 0`),
		check("users_monthly_upload_limit_check", sql`monthly_upload_limit_gb >= 0`),
		check("users_used_upload_bytes_check", sql`used_upload_bytes >= 0`),
		check("users_plan_code_check", sql`plan_code IN ('free', 'basic', 'pro')`),
		check("users_quota_source_check", sql`quota_source IN ('plan', 'admin')`),
	],
);

export const accountDeletionRequests = pgTable(
	"account_deletion_requests",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "account_deletion_requests_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		reason: text().notNull(),
		requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }).notNull(),
		userId: text("user_id").notNull(),
	},
	(table) => [
		index("account_deletion_requests_user_id_idx").using("btree", table.userId.asc().nullsLast()),
		index("account_deletion_requests_user_requested_idx").using(
			"btree",
			table.userId.asc().nullsLast(),
			table.requestedAt.desc().nullsFirst(),
		),
		foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "account_deletion_requests_user_id_fkey",
		}).onDelete("cascade"),
	],
);

// ---------------------------------------------------------------------------
// Durable delivery / cleanup outbox
// ---------------------------------------------------------------------------

export const externalTasks = pgTable(
	"external_tasks",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "external_tasks_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		kind: varchar({ length: 32 }).notNull(),
		payload: jsonb().$type<Record<string, unknown>>().notNull(),
		dedupeKey: varchar("dedupe_key", { length: 255 }).notNull(),
		attempts: integer().notNull().default(0),
		availableAt: timestamp("available_at", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
		lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
		completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
		deadAt: timestamp("dead_at", { withTimezone: true, mode: "string" }),
		effectAppliedAt: timestamp("effect_applied_at", {
			withTimezone: true,
			mode: "string",
		}),
		lastError: text("last_error").notNull().default(""),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("external_tasks_dedupe_key_key").on(table.dedupeKey),
		index("external_tasks_ready_idx")
			.on(table.availableAt, table.id)
			.where(sql`completed_at IS NULL AND dead_at IS NULL`),
		index("external_tasks_completed_idx")
			.on(table.completedAt, table.id)
			.where(sql`completed_at IS NOT NULL`),
		check(
			"external_tasks_kind_check",
			sql`kind IN ('sqs_job', 'storage_cleanup', 'invitation_email')`,
		),
		check("external_tasks_attempts_check", sql`attempts >= 0`),
	],
);

/** SQS/Lambda の at-least-once 配送を job_id 単位で一度だけclaimする台帳。 */
export const jobExecutions = pgTable(
	"job_executions",
	{
		jobId: varchar("job_id", { length: 128 }).primaryKey(),
		jobType: varchar("job_type", { length: 64 }).notNull(),
		payloadSha256: varchar("payload_sha256", { length: 64 }).notNull(),
		status: varchar({ length: 16 }).notNull(),
		attempts: integer().notNull().default(0),
		leaseToken: varchar("lease_token", { length: 36 }),
		leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "string" }),
		completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
		lastError: text("last_error").notNull().default(""),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("job_executions_completed_idx")
			.on(table.completedAt, table.jobId)
			.where(sql`completed_at IS NOT NULL`),
		check(
			"job_executions_status_check",
			sql`status IN ('running', 'failed', 'completed')`,
		),
		check("job_executions_attempts_check", sql`attempts >= 0`),
	],
);

/**
 * MCP の作成系ツールを at-most-once にする台帳。
 *
 * resourceId は action ごとに videos / video_courses の id を指す。対象作成と
 * 同じ transaction で記録し、同じ user/action/key の再試行では既存 id を返す。
 */
export const mcpIdempotencyRecords = pgTable(
	"mcp_idempotency_records",
	{
		userId: text("user_id").notNull(),
		action: varchar({ length: 64 }).notNull(),
		key: varchar({ length: 128 }).notNull(),
		requestHash: varchar("request_hash", { length: 64 }).notNull(),
		resourceId: bigint("resource_id", { mode: "number" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
	},
	(table) => [
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
		check(
			"mcp_idempotency_records_action_check",
			sql`action IN ('request_video_upload', 'create_youtube_video', 'create_course')`,
		),
		check(
			"mcp_idempotency_records_request_hash_check",
			sql`request_hash ~ '^[0-9a-f]{64}$'`,
		),
	],
);

// ---------------------------------------------------------------------------
// Videos, courses, tags
// ---------------------------------------------------------------------------

// Business records retain the NO ACTION user references established by 0006.
// The deletion worker removes media and dependent records before the user row.

export const videos = pgTable(
	"videos",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "videos_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		transcriptionLanguage: varchar("transcription_language", { length: 3 }),
		file: varchar({ length: 100 }).notNull(),
		multipartUpload: jsonb("multipart_upload").$type<{
			uploadId: string;
			partSize: number;
			contentType: string;
		}>(),
		uploadHeartbeatAt: timestamp("upload_heartbeat_at", { withTimezone: true, mode: "string" }),
		/** Month of admission, also used to refund an unconfirmed upload exactly once. */
		uploadUsagePeriodStart: timestamp("upload_usage_period_start", { withTimezone: true, mode: "string" }),
		title: varchar({ length: 255 }).notNull(),
		description: text().notNull(),
		uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "string" }).notNull(),
		transcript: text().notNull(),
		status: varchar({ length: 20 }).notNull(),
		errorMessage: text("error_message").notNull(),
		processingSeconds: integer("processing_seconds").notNull().default(0),
		userId: text("user_id").notNull(),
		sourceType: varchar("source_type", { length: 20 }).notNull(),
		sourceUrl: varchar("source_url", { length: 200 }).notNull(),
		youtubeVideoId: varchar("youtube_video_id", { length: 32 }).notNull(),
	},
	(table) => [
		index("videos_user_id_idx").using("btree", table.userId.asc().nullsLast()),
		index("videos_status_idx").using("btree", table.status.asc().nullsLast()),
		index("videos_uploaded_at_idx").using("btree", table.uploadedAt.asc().nullsLast()),
		index("videos_user_status_uploaded_idx").using(
			"btree",
			table.userId.asc().nullsLast(),
			table.status.asc().nullsLast(),
			table.uploadedAt.desc().nullsFirst(),
		),
		foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "videos_user_id_fkey",
		}).onDelete("no action"),
		check("videos_processing_seconds_check", sql`processing_seconds >= 0`),
	],
);

/** Durable per-video plan and checkpoints for bounded transcription jobs. */
export const videoTranscriptionRuns = pgTable("video_transcription_runs", {
	videoId: bigint("video_id", { mode: "number" }).primaryKey().references(() => videos.id, { onDelete: "cascade" }),
	runId: uuid("run_id").notNull().unique(),
	fileKey: varchar("file_key", { length: 100 }).notNull(),
	transcriptHash: varchar("transcript_hash", { length: 32 }).notNull(),
	durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
	chunkSeconds: integer("chunk_seconds").notNull(),
	chunkCount: integer("chunk_count").notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
	check("video_transcription_runs_duration_check", sql`${table.durationMs} > 0`),
	check("video_transcription_runs_chunks_check", sql`${table.chunkSeconds} > 0 AND ${table.chunkCount} BETWEEN 1 AND 10000`),
]);

export const videoTranscriptionChunks = pgTable("video_transcription_chunks", {
	runId: uuid("run_id").notNull(),
	chunkIndex: integer("chunk_index").notNull(),
	segments: jsonb().$type<{ start: number; end: number; text: string }[]>(),
	fallbackSegments: jsonb("fallback_segments").$type<Record<string, { start: number; end: number; text: string }[]>>().notNull().default({}),
	failures: integer().notNull().default(0),
	lastError: text("last_error").notNull().default(""),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
	primaryKey({ columns: [table.runId, table.chunkIndex] }),
	foreignKey({ columns: [table.runId], foreignColumns: [videoTranscriptionRuns.runId], name: "video_transcription_chunks_run_id_fkey" }).onDelete("cascade"),
	check("video_transcription_chunks_index_check", sql`${table.chunkIndex} >= 0`),
	check("video_transcription_chunks_failures_check", sql`${table.failures} >= 0`),
]);

export const videoVisualRuns = pgTable("video_visual_runs", {
	videoId: bigint("video_id", { mode: "number" }).primaryKey().references(() => videos.id, { onDelete: "cascade" }),
	runId: uuid("run_id").notNull().unique(),
	fileKey: varchar("file_key", { length: 100 }).notNull(),
	durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
	chunkCount: integer("chunk_count").notNull(),
	status: varchar({ length: 16 }).notNull().default("processing"),
	lastError: text("last_error").notNull().default(""),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
	check("video_visual_runs_duration_check", sql`${table.durationMs} > 0 AND ${table.durationMs} <= 36000000`),
	check("video_visual_runs_chunks_check", sql`${table.chunkCount} BETWEEN 1 AND 600`),
	check("video_visual_runs_status_check", sql`${table.status} IN ('processing', 'ready', 'error')`),
]);

export const videoVisualChunks = pgTable("video_visual_chunks", {
	runId: uuid("run_id").notNull(),
	chunkIndex: integer("chunk_index").notNull(),
	frameCount: integer("frame_count"),
	failures: integer().notNull().default(0),
	lastError: text("last_error").notNull().default(""),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
	primaryKey({ columns: [table.runId, table.chunkIndex] }),
	foreignKey({ columns: [table.runId], foreignColumns: [videoVisualRuns.runId], name: "video_visual_chunks_run_id_fkey" }).onDelete("cascade"),
	check("video_visual_chunks_index_check", sql`${table.chunkIndex} BETWEEN 0 AND 599`),
	check("video_visual_chunks_frames_check", sql`${table.frameCount} IS NULL OR ${table.frameCount} BETWEEN 0 AND 60`),
	check("video_visual_chunks_failures_check", sql`${table.failures} >= 0`),
]);

export const videoCourses = pgTable(
	"video_courses",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "video_courses_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		name: varchar({ length: 255 }).notNull(),
		description: text().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
		userId: text("user_id").notNull(),
		shareSlug: varchar("share_slug", { length: 64 }),
		displayOrder: integer("display_order").notNull(),
	},
	(table) => [
		index("video_courses_user_id_idx").using("btree", table.userId.asc().nullsLast()),
		index("video_courses_share_slug_idx")
			.using("btree", table.shareSlug.asc().nullsLast())
			.where(sql`(share_slug IS NOT NULL)`),
		uniqueIndex("video_courses_share_slug_ci_uniq")
			.using("btree", sql`lower((share_slug)::text)`)
			.where(sql`(share_slug IS NOT NULL)`),
		foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "video_courses_user_id_fkey",
		}).onDelete("no action"),
	],
);

export const videoCourseMembers = pgTable(
	"video_course_members",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "video_course_members_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		addedAt: timestamp("added_at", { withTimezone: true, mode: "string" }).notNull(),
		order: integer().notNull(),
		courseId: bigint("course_id", { mode: "number" }).notNull(),
		videoId: bigint("video_id", { mode: "number" }).notNull(),
	},
	(table) => [
		index("video_course_members_course_id_idx").using("btree", table.courseId.asc().nullsLast()),
		index("video_course_members_video_id_idx").using("btree", table.videoId.asc().nullsLast()),
		index("video_course_members_course_order_idx").using(
			"btree",
			table.courseId.asc().nullsLast(),
			table.order.asc().nullsLast(),
		),
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
	],
);

/** Email-bound invitations for user membership in a video course. */
export const videoCourseInvitations = pgTable(
	"video_course_invitations",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "video_course_invitations_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		courseId: bigint("course_id", { mode: "number" }).notNull(),
		email: varchar({ length: 254 }).notNull(),
		invitedByUserId: text("invited_by_user_id").notNull(),
		status: varchar({ length: 20 }).notNull().default("pending"),
		deliveryStatus: varchar("delivery_status", { length: 20 }).notNull().default("queued"),
		tokenHash: varchar("token_hash", { length: 64 }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
		acceptedByUserId: text("accepted_by_user_id"),
		acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
		lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: "string" }),
		sendAttempts: integer("send_attempts").notNull().default(0),
		lastError: text("last_error"),
	},
	(table) => [
		index("video_course_invitations_course_status_idx").using(
			"btree",
			table.courseId.asc().nullsLast(),
			table.status.asc().nullsLast(),
		),
		index("video_course_invitations_email_idx").using("btree", table.email.asc().nullsLast()),
		unique("video_course_invitations_token_hash_key").on(table.tokenHash),
		uniqueIndex("video_course_invitations_pending_email_uniq")
			.on(table.courseId, table.email)
			.where(sql`status = 'pending'`),
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
		check(
			"video_course_invitations_status_check",
			sql`status IN ('pending', 'accepted', 'declined', 'expired', 'revoked')`,
		),
		check(
			"video_course_invitations_delivery_status_check",
			sql`delivery_status IN ('queued', 'sent', 'failed')`,
		),
		check("video_course_invitations_send_attempts_check", sql`send_attempts >= 0`),
	],
);

/** Accepted user memberships. Owners are represented by video_courses.user_id, not here. */
export const videoCourseMemberships = pgTable(
	"video_course_memberships",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "video_course_memberships_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		courseId: bigint("course_id", { mode: "number" }).notNull(),
		userId: text("user_id").notNull(),
		invitationId: bigint("invitation_id", { mode: "number" }),
		joinedAt: timestamp("joined_at", { withTimezone: true, mode: "string" }).notNull(),
	},
	(table) => [
		index("video_course_memberships_course_id_idx").using("btree", table.courseId.asc().nullsLast()),
		index("video_course_memberships_user_id_idx").using("btree", table.userId.asc().nullsLast()),
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
	],
);

export const tags = pgTable(
	"tags",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "tags_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		name: varchar({ length: 50 }).notNull(),
		color: varchar({ length: 20 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
		userId: text("user_id").notNull(),
	},
	(table) => [
		index("tags_user_id_idx").using("btree", table.userId.asc().nullsLast()),
		foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "tags_user_id_fkey",
		}).onDelete("no action"),
		unique("tags_user_id_name_uniq").on(table.name, table.userId),
	],
);

export const videoTags = pgTable(
	"video_tags",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "video_tags_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		addedAt: timestamp("added_at", { withTimezone: true, mode: "string" }).notNull(),
		tagId: bigint("tag_id", { mode: "number" }).notNull(),
		videoId: bigint("video_id", { mode: "number" }).notNull(),
	},
	(table) => [
		index("video_tags_tag_id_idx").using("btree", table.tagId.asc().nullsLast()),
		index("video_tags_video_id_idx").using("btree", table.videoId.asc().nullsLast()),
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
	],
);

// ---------------------------------------------------------------------------
// Chat and archived evaluation records
// ---------------------------------------------------------------------------

export const chatLogs = pgTable(
	"chat_logs",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "chat_logs_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		question: text().notNull(),
		response: jsonb().$type<import("@videoq/trpc/chat").ChatAnswer>().notNull(),
		isSharedOrigin: boolean("is_shared_origin").notNull(),
		feedback: varchar({ length: 4 }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
		userId: text("user_id").notNull(),
		courseId: bigint("course_id", { mode: "number" }).notNull(),
		retrievedContexts: jsonb("retrieved_contexts").notNull(),
	},
	(table) => [
		index("chat_logs_user_id_idx").using("btree", table.userId.asc().nullsLast()),
		index("chat_logs_course_id_idx").using("btree", table.courseId.asc().nullsLast()),
		index("chat_logs_course_created_idx").using(
			"btree",
			table.courseId.asc().nullsLast(),
			table.createdAt.desc().nullsFirst(),
		),
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
	],
);

/** Anonymous cost ledger: no user ID, prompt, response, or provider credential. */
export const aiAnswerAttempts = pgTable(
	"ai_answer_attempts",
	{
		id: uuid().primaryKey(),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		planCode: text("plan_code").notNull(),
		quotaSource: text("quota_source").notNull(),
		hasCourse: boolean("has_course").notNull(),
		streamed: boolean().notNull(),
		status: text().notNull(),
		quotaConsumed: boolean("quota_consumed"),
		providerCalls: jsonb("provider_calls").$type<Record<string, unknown>[]>().notNull().default([]),
	},
	(table) => [
		index("ai_answer_attempts_started_idx").on(table.startedAt),
		check("ai_answer_attempts_status_check", sql`status IN ('started', 'completed', 'failed', 'interrupted')`),
	],
);

// Retained for historical data only; automated evaluation was retired.
export const chatLogEvaluations = pgTable(
	"chat_log_evaluations",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "chat_log_evaluations_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		status: varchar({ length: 20 }).notNull(),
		faithfulness: doublePrecision(),
		answerRelevancy: doublePrecision("answer_relevancy"),
		contextPrecision: doublePrecision("context_precision"),
		errorMessage: text("error_message").notNull(),
		evaluatedAt: timestamp("evaluated_at", { withTimezone: true, mode: "string" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
		chatLogId: bigint("chat_log_id", { mode: "number" }).notNull(),
	},
	(table) => [
		index("chat_log_evaluations_status_idx").using("btree", table.status.asc().nullsLast()),
		foreignKey({
			columns: [table.chatLogId],
			foreignColumns: [chatLogs.id],
			name: "chat_log_evaluations_chat_log_id_fkey",
		}).onDelete("cascade"),
		unique("chat_log_evaluations_chat_log_id_key").on(table.chatLogId),
	],
);

export const courseEvaluationSnapshots = pgTable(
	"course_evaluation_snapshots",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({
			name: "course_evaluation_snapshots_id_seq",
			startWith: 1,
			increment: 1,
			minValue: 1,
			maxValue: "9223372036854775807",
			cache: 1,
		}),
		sampleCount: integer("sample_count").notNull(),
		faithfulnessMean: doublePrecision("faithfulness_mean"),
		answerRelevancyMean: doublePrecision("answer_relevancy_mean"),
		samples: jsonb().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
		courseId: bigint("course_id", { mode: "number" }).notNull(),
		userId: text("user_id").notNull(),
		contextPrecisionMean: doublePrecision("context_precision_mean"),
	},
	(table) => [
		index("course_evaluation_snapshots_user_id_idx").using("btree", table.userId.asc().nullsLast()),
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
	],
);

// ---------------------------------------------------------------------------
// Vector embeddings
// ---------------------------------------------------------------------------

export const sceneEmbeddings = pgTable(
	"scene_embeddings",
	{
		langchainId: uuid("langchain_id").primaryKey().notNull(),
		content: text().notNull(),
		embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
		userId: text("user_id").notNull(),
		videoId: bigint("video_id", { mode: "number" }).notNull(),
		langchainMetadata: json("langchain_metadata"),
	},
	(table) => [
		index("scene_embeddings_user_id_idx").on(table.userId),
		index("scene_embeddings_video_id_idx").on(table.videoId),
	],
);

// Keep the hosted index intact during the explicit local-model cutover.
// Different model spaces are never searched together, even for the same video.
export const sceneEmbeddings768 = pgTable(
	"scene_embeddings_768",
	{
		langchainId: uuid("langchain_id").primaryKey().notNull(),
		content: text().notNull(),
		embedding: vector({ dimensions: 768 }).notNull(),
		userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		videoId: bigint("video_id", { mode: "number" }).notNull().references(() => videos.id, { onDelete: "cascade" }),
		langchainMetadata: json("langchain_metadata"),
	},
	(table) => [
		index("scene_embeddings_768_user_id_idx").on(table.userId),
		index("scene_embeddings_768_video_id_idx").on(table.videoId),
	],
);

export const stripeEvents = pgTable("stripe_events", {
	id: text("id").primaryKey(),
	type: text("type").notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: "string" })
		.notNull()
		.defaultNow(),
});
