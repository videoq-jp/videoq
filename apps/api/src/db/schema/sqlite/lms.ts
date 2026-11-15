// SQLite / D1 schema. PostgreSQL history is maintained independently.
import { sqliteTable, text, integer, index, uniqueIndex, foreignKey, check, unique, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { isoDate } from "./columns";
import { externalTasks, users, videoCourses, videos } from "./modern";
/** Identifier-only record of a successful, capability-authorized aggregate read. */
export const ltiReportAccesses = sqliteTable('lti_report_accesses', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    installationId: text('installation_id').notNull().references(() => lmsInstallations.id, { onDelete: 'cascade' }),
    courseId: integer('course_id').notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
    contextId: text('context_id').notNull(),
    actorKey: text('actor_key').notNull(),
    fromDate: text('from_date').notNull(),
    toDate: text('to_date').notNull(),
    resourceCount: integer('resource_count').notNull(),
    scopeHash: text('scope_hash').notNull(),
    createdAt: isoDate('created_at').notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [index('lti_report_accesses_actor_idx').on(table.actorKey, table.courseId, table.id),
    index('lti_report_accesses_retention_idx').on(table.createdAt, table.id),
    check('lti_report_accesses_actor_check', sql `(length(${table.actorKey}) = 64 AND ${table.actorKey} NOT GLOB '*[^a-f0-9]*')`),
    check('lti_report_accesses_scope_check', sql `(length(${table.scopeHash}) = 64 AND ${table.scopeHash} NOT GLOB '*[^a-f0-9]*')`),
    check('lti_report_accesses_count_check', sql `${table.resourceCount} BETWEEN 0 AND 1000`),
    check('lti_report_accesses_period_check', sql `${table.toDate} >= ${table.fromDate} AND julianday(${table.toDate}) - julianday(${table.fromDate}) < 366`),
]);
/** Persistent application signing identity; never expires with learner sessions. */
export const ltiToolKeys = sqliteTable("lti_tool_keys", {
    id: text("id").primaryKey(),
    encryptedKeyRing: text("encrypted_key_ring").notNull(),
    createdAt: isoDate("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});
/** A revocable LTI identity, using either a materials service or legacy push. */
export const lmsInstallations = sqliteTable("lms_installations", {
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
    materialsService: text("materials_service", { mode: "json" }).$type<{
        tokenEndpoint: string;
        endpoint: string;
    }>(),
    nextMaterialsSyncAt: text("next_materials_sync_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    materialsCursor: integer("materials_cursor").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [
    index("lms_installations_owner_idx").on(table.ownerUserId),
    unique("lms_installations_identity_key").on(table.issuer, table.clientId),
    unique("lms_installations_sync_token_key").on(table.syncTokenHash),
    check("lms_installations_auth_mode_check", sql `(${table.materialsService} IS NULL AND ${table.syncTokenHash} IS NOT NULL) OR (${table.materialsService} IS NOT NULL AND ${table.syncTokenHash} IS NULL)`),
    check("lms_installations_token_hash_check", sql `(length(${table.syncTokenHash}) = 64 AND ${table.syncTokenHash} NOT GLOB '*[^a-f0-9]*')`),
]);
/** One VideoQ course per LMS installation and Moodle course context. */
export const lmsCourses = sqliteTable("lms_courses", {
    id: text("id").primaryKey(),
    installationId: text("installation_id").notNull().references(() => lmsInstallations.id, { onDelete: "cascade" }),
    contextId: text("context_id").notNull(),
    courseId: integer("course_id").notNull().references(() => videoCourses.id, { onDelete: "cascade" }),
}, table => [unique("lms_courses_context_key").on(table.installationId, table.contextId)]);
/** Stable Moodle activity identities and monotonically ordered desired state. */
export const lmsResources = sqliteTable("lms_resources", {
    id: text("id").primaryKey(),
    installationId: text("installation_id").notNull().references(() => lmsInstallations.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    kind: text('kind').notNull().default('video'),
    contextId: text("context_id").notNull(),
    resourceLinkId: text("resource_link_id").notNull(),
    generation: integer("generation").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    contentHash: text("content_hash"),
    contentType: text("content_type"),
    fileSize: integer("file_size"),
    youtubeVideoId: text('youtube_video_id'),
    courseId: integer("course_id").references(() => videoCourses.id, { onDelete: "set null" }),
    videoId: integer("video_id").references(() => videos.id, { onDelete: "set null" }),
    syncError: text("sync_error"),
    updatedAt: text("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [
    index("lms_resources_video_idx").on(table.videoId),
    unique("lms_resources_external_key").on(table.installationId, table.externalId),
    unique("lms_resources_launch_key").on(table.installationId, table.contextId, table.resourceLinkId),
    check("lms_resources_generation_check", sql `${table.generation} > 0`),
    check('lms_resources_kind_check', sql `${table.kind} IN ('video','course','youtube')`),
    check('lms_resources_course_media_check', sql `${table.kind} <> 'course' OR (${table.videoId} IS NULL AND ${table.contentHash} IS NULL AND ${table.contentType} IS NULL AND ${table.fileSize} IS NULL)`),
    check('lms_resources_youtube_check', sql `(${table.kind} = 'youtube' AND ${table.contentHash} IS NULL AND ${table.contentType} IS NULL AND ${table.fileSize} IS NULL AND (${table.youtubeVideoId} IS NULL OR ((length(${table.youtubeVideoId}) = 11 AND ${table.youtubeVideoId} NOT GLOB '*[^A-Za-z0-9_-]*') AND ${table.youtubeVideoId} GLOB '*[A-Za-z0-9]*')) AND (NOT ${table.enabled} OR ${table.youtubeVideoId} IS NOT NULL)) OR (${table.kind} <> 'youtube' AND ${table.youtubeVideoId} IS NULL)`),
    uniqueIndex('lms_resources_course_entry_key').on(table.installationId, table.contextId).where(sql `${table.kind} = 'course'`),
]);
/** Idempotent teacher mutations and identifier-only audit; no draft content or credentials. */
export const ltiMaterialOperations = sqliteTable('lti_material_operations', {
    id: text('id').primaryKey(),
    resourceId: text('resource_id').notNull(),
    videoId: integer('video_id'),
    courseId: integer('course_id').notNull(),
    sourceGeneration: integer('source_generation').notNull(),
    actorKey: text('actor_key').notNull(),
    action: text('action').notNull(),
    requestHash: text('request_hash').notNull(),
    beforeRevision: text('before_revision').notNull(),
    afterRevision: text('after_revision').notNull(),
    externalTaskId: integer('external_task_id'),
    createdAt: isoDate('created_at').notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [
    foreignKey({ columns: [table.resourceId], foreignColumns: [lmsResources.id], name: 'lti_material_ops_resource_fk' }).onDelete('cascade'),
    foreignKey({ columns: [table.videoId], foreignColumns: [videos.id], name: 'lti_material_ops_video_fk' }).onDelete('set null'),
    foreignKey({ columns: [table.courseId], foreignColumns: [videoCourses.id], name: 'lti_material_ops_course_fk' }).onDelete('cascade'),
    foreignKey({ columns: [table.externalTaskId], foreignColumns: [externalTasks.id], name: 'lti_material_ops_task_fk' }).onDelete('set null'),
    index('lti_material_ops_resource_created_idx').on(table.resourceId, table.createdAt),
    index('lti_material_ops_actor_idx').on(table.actorKey, table.createdAt),
    index('lti_material_ops_retention_idx').on(table.createdAt, table.id),
    check('lti_material_ops_action_check', sql `${table.action} IN ('update','reindex','retry')`),
    check('lti_material_ops_actor_check', sql `(length(${table.actorKey}) = 64 AND ${table.actorKey} NOT GLOB '*[^a-f0-9]*')`),
]);
/** Moodle course vocabulary is separate from the connected owner's global tags. */
export const ltiCourseTags = sqliteTable('lti_course_tags', {
    id: text('id').primaryKey(),
    courseId: integer('course_id').notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    revision: text('revision').notNull().$defaultFn(() => crypto.randomUUID()),
}, table => [unique('lti_course_tags_name_key').on(table.courseId, table.name)]);
export const ltiCourseVideoTags = sqliteTable('lti_course_video_tags', {
    tagId: text('tag_id').notNull().references(() => ltiCourseTags.id, { onDelete: 'cascade' }),
    videoId: integer('video_id').notNull().references(() => videos.id, { onDelete: 'cascade' }),
}, table => [primaryKey({ columns: [table.tagId, table.videoId] }), index('lti_course_video_tags_video_idx').on(table.videoId)]);
/** Identifier-only idempotency/audit receipts; never store tag text or credentials. */
export const ltiCourseTagOperations = sqliteTable('lti_course_tag_operations', {
    id: text('id').primaryKey(),
    courseId: integer('course_id').notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
    actorKey: text('actor_key').notNull(),
    action: text('action').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: isoDate('created_at').notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [index('lti_course_tag_ops_course_idx').on(table.courseId, table.createdAt),
    index('lti_course_tag_ops_retention_idx').on(table.createdAt, table.id),
    check('lti_course_tag_ops_action_check', sql `${table.action} IN ('create','update','delete','assign')`),
    check('lti_course_tag_ops_actor_check', sql `(length(${table.actorKey}) = 64 AND ${table.actorKey} NOT GLOB '*[^a-f0-9]*')`)]);
/** Permanent replay barriers contain only a namespaced hash of a random operation UUID. */
export const ltiOperationReservations = sqliteTable('lti_operation_reservations', {
    key: text('key').primaryKey(),
}, table => [check('lti_operation_reservation_key_format', sql `(length(${table.key}) = 64 AND ${table.key} NOT GLOB '*[^a-f0-9]*')`)]);

/** A teacher explicitly authorizes one LMS classroom to use one owned course. */
export const teachingConnections = sqliteTable('teaching_connections', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  provider: text('provider').notNull(),
  installationId: text('installation_id').notNull(),
  contextId: text('context_id').notNull(),
  teacherSubject: text('teacher_subject').notNull(),
  resourceLinkId: text('resource_link_id'),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  courseId: integer('course_id').notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: isoDate('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
}, table => [unique('teaching_connections_context_key').on(table.provider, table.installationId, table.contextId),
  index('teaching_connections_owner_idx').on(table.ownerUserId),
  check('teaching_connections_provider_check', sql`${table.provider} IN ('moodle','classroom')`)]);
