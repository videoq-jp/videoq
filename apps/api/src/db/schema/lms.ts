import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { externalTasks, users, videoCourses, videos } from "./modern";

/** Identifier-only record of a successful, capability-authorized aggregate read. */
export const ltiReportAccesses = pgTable('lti_report_accesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  installationId: text('installation_id').notNull().references(() => lmsInstallations.id, { onDelete: 'cascade' }),
  courseId: bigint('course_id', { mode: 'number' }).notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
  contextId: text('context_id').notNull(),
  actorKey: varchar('actor_key', { length: 64 }).notNull(),
  fromDate: date('from_date', { mode: 'string' }).notNull(),
  toDate: date('to_date', { mode: 'string' }).notNull(),
  resourceCount: integer('resource_count').notNull(),
  scopeHash: varchar('scope_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('lti_report_accesses_actor_idx').on(table.actorKey, table.courseId, table.id),
  index('lti_report_accesses_retention_idx').on(table.createdAt, table.id),
  check('lti_report_accesses_actor_check', sql`${table.actorKey} ~ '^[a-f0-9]{64}$'`),
  check('lti_report_accesses_scope_check', sql`${table.scopeHash} ~ '^[a-f0-9]{64}$'`),
  check('lti_report_accesses_count_check', sql`${table.resourceCount} BETWEEN 0 AND 1000`),
  check('lti_report_accesses_period_check', sql`${table.toDate} >= ${table.fromDate} AND ${table.toDate} - ${table.fromDate} < 366`),
]);

/** Persistent application signing identity; never expires with learner sessions. */
export const ltiToolKeys = pgTable("lti_tool_keys", {
  id: text("id").primaryKey(),
  encryptedKeyRing: text("encrypted_key_ring").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A revocable LTI identity, using either a materials service or legacy push. */
export const lmsInstallations = pgTable("lms_installations", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  issuer: text("issuer").notNull(),
  clientId: text("client_id").notNull(),
  deploymentId: text("deployment_id").notNull(),
  authorizationUrl: text("authorization_url").notNull(),
  jwksUrl: text("jwks_url").notNull(),
  /** The API never stores or returns the original bearer credential. */
  syncTokenHash: text("sync_token_hash"),
  /** Generic LTI materials service; legacy push connections have no service. */
  materialsService: jsonb("materials_service").$type<{ tokenEndpoint: string; endpoint: string }>(),
  nextMaterialsSyncAt: timestamp("next_materials_sync_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  materialsCursor: bigint("materials_cursor", { mode: "number" }).notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, table => [
  index("lms_installations_owner_idx").on(table.ownerUserId),
  unique("lms_installations_identity_key").on(table.issuer, table.clientId),
  unique("lms_installations_sync_token_key").on(table.syncTokenHash),
  check("lms_installations_auth_mode_check", sql`(${table.materialsService} IS NULL AND ${table.syncTokenHash} IS NOT NULL) OR (${table.materialsService} IS NOT NULL AND ${table.syncTokenHash} IS NULL)`),
  check("lms_installations_token_hash_check", sql`${table.syncTokenHash} ~ '^[a-f0-9]{64}$'`),
]);

/** One VideoQ course per LMS installation and Moodle course context. */
export const lmsCourses = pgTable("lms_courses", {
  id: uuid("id").primaryKey(),
  installationId: text("installation_id").notNull().references(() => lmsInstallations.id, { onDelete: "cascade" }),
  contextId: text("context_id").notNull(),
  courseId: bigint("course_id", { mode: "number" }).notNull().references(() => videoCourses.id, { onDelete: "cascade" }),
}, table => [unique("lms_courses_context_key").on(table.installationId, table.contextId)]);

/** Stable Moodle activity identities and monotonically ordered desired state. */
export const lmsResources = pgTable("lms_resources", {
  id: uuid("id").primaryKey(),
  installationId: text("installation_id").notNull().references(() => lmsInstallations.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  kind: text('kind').notNull().default('video'),
  contextId: text("context_id").notNull(),
  resourceLinkId: text("resource_link_id").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull(),
  manifestHash: text("manifest_hash").notNull(),
  enabled: boolean("enabled").notNull(),
  contentHash: text("content_hash"),
  contentType: text("content_type"),
  fileSize: bigint("file_size", { mode: "number" }),
  youtubeVideoId: varchar('youtube_video_id', { length: 11 }),
  courseId: bigint("course_id", { mode: "number" }).references(() => videoCourses.id, { onDelete: "set null" }),
  videoId: bigint("video_id", { mode: "number" }).references(() => videos.id, { onDelete: "set null" }),
  syncError: text("sync_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, table => [
  unique("lms_resources_external_key").on(table.installationId, table.externalId),
  unique("lms_resources_launch_key").on(table.installationId, table.contextId, table.resourceLinkId),
  check("lms_resources_generation_check", sql`${table.generation} > 0`),
  check('lms_resources_kind_check', sql`${table.kind} IN ('video','course','youtube')`),
  check('lms_resources_course_media_check', sql`${table.kind} <> 'course' OR (${table.videoId} IS NULL AND ${table.contentHash} IS NULL AND ${table.contentType} IS NULL AND ${table.fileSize} IS NULL)`),
  check('lms_resources_youtube_check', sql`(${table.kind} = 'youtube' AND ${table.contentHash} IS NULL AND ${table.contentType} IS NULL AND ${table.fileSize} IS NULL AND (${table.youtubeVideoId} IS NULL OR (${table.youtubeVideoId} ~ '^[A-Za-z0-9_-]{11}$' AND ${table.youtubeVideoId} ~ '[A-Za-z0-9]')) AND (NOT ${table.enabled} OR ${table.youtubeVideoId} IS NOT NULL)) OR (${table.kind} <> 'youtube' AND ${table.youtubeVideoId} IS NULL)`),
  uniqueIndex('lms_resources_course_entry_key').on(table.installationId, table.contextId).where(sql`${table.kind} = 'course'`),
]);

/** Idempotent teacher mutations and identifier-only audit; no draft content or credentials. */
export const ltiMaterialOperations = pgTable('lti_material_operations', {
  id: uuid('id').primaryKey(),
  resourceId: uuid('resource_id').notNull(),
  videoId: bigint('video_id', { mode: 'number' }),
  courseId: bigint('course_id', { mode: 'number' }).notNull(),
  sourceGeneration: bigint('source_generation', { mode: 'number' }).notNull(),
  actorKey: varchar('actor_key', { length: 64 }).notNull(),
  action: text('action').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  beforeRevision: varchar('before_revision', { length: 64 }).notNull(),
  afterRevision: varchar('after_revision', { length: 64 }).notNull(),
  externalTaskId: bigint('external_task_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ columns: [table.resourceId], foreignColumns: [lmsResources.id], name: 'lti_material_ops_resource_fk' }).onDelete('cascade'),
  foreignKey({ columns: [table.videoId], foreignColumns: [videos.id], name: 'lti_material_ops_video_fk' }).onDelete('set null'),
  foreignKey({ columns: [table.courseId], foreignColumns: [videoCourses.id], name: 'lti_material_ops_course_fk' }).onDelete('cascade'),
  foreignKey({ columns: [table.externalTaskId], foreignColumns: [externalTasks.id], name: 'lti_material_ops_task_fk' }).onDelete('set null'),
  index('lti_material_ops_resource_created_idx').on(table.resourceId, table.createdAt),
  index('lti_material_ops_actor_idx').on(table.actorKey, table.createdAt),
  index('lti_material_ops_retention_idx').on(table.createdAt, table.id),
  check('lti_material_ops_action_check', sql`${table.action} IN ('update','reindex','retry')`),
  check('lti_material_ops_actor_check', sql`${table.actorKey} ~ '^[a-f0-9]{64}$'`),
]);

/** Moodle course vocabulary is separate from the connected owner's global tags. */
export const ltiCourseTags = pgTable('lti_course_tags', {
  id: uuid('id').primaryKey(),
  courseId: bigint('course_id', { mode: 'number' }).notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 50 }).notNull(),
  color: varchar('color', { length: 20 }).notNull(),
  revision: uuid('revision').notNull().defaultRandom(),
}, table => [unique('lti_course_tags_name_key').on(table.courseId, table.name)]);

export const ltiCourseVideoTags = pgTable('lti_course_video_tags', {
  tagId: uuid('tag_id').notNull().references(() => ltiCourseTags.id, { onDelete: 'cascade' }),
  videoId: bigint('video_id', { mode: 'number' }).notNull().references(() => videos.id, { onDelete: 'cascade' }),
}, table => [primaryKey({ columns: [table.tagId, table.videoId] }), index('lti_course_video_tags_video_idx').on(table.videoId)]);

/** Identifier-only idempotency/audit receipts; never store tag text or credentials. */
export const ltiCourseTagOperations = pgTable('lti_course_tag_operations', {
  id: uuid('id').primaryKey(),
  courseId: bigint('course_id', { mode: 'number' }).notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
  actorKey: varchar('actor_key', { length: 64 }).notNull(),
  action: text('action').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('lti_course_tag_ops_course_idx').on(table.courseId, table.createdAt),
  index('lti_course_tag_ops_retention_idx').on(table.createdAt, table.id),
  check('lti_course_tag_ops_action_check', sql`${table.action} IN ('create','update','delete','assign')`),
  check('lti_course_tag_ops_actor_check', sql`${table.actorKey} ~ '^[a-f0-9]{64}$'`)]);

/** Permanent replay barriers contain only a namespaced hash of a random operation UUID. */
export const ltiOperationReservations = pgTable('lti_operation_reservations', {
  key: varchar('key', { length: 64 }).primaryKey(),
}, table => [check('lti_operation_reservation_key_format', sql`${table.key} ~ '^[a-f0-9]{64}$'`)]);
