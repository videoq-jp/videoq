import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users, videoCourses, videos } from "./modern";

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
  contextId: text("context_id").notNull(),
  resourceLinkId: text("resource_link_id").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull(),
  manifestHash: text("manifest_hash").notNull(),
  enabled: boolean("enabled").notNull(),
  contentHash: text("content_hash"),
  contentType: text("content_type"),
  fileSize: bigint("file_size", { mode: "number" }),
  courseId: bigint("course_id", { mode: "number" }).references(() => videoCourses.id, { onDelete: "set null" }),
  videoId: bigint("video_id", { mode: "number" }).references(() => videos.id, { onDelete: "set null" }),
  syncError: text("sync_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, table => [
  unique("lms_resources_external_key").on(table.installationId, table.externalId),
  unique("lms_resources_launch_key").on(table.installationId, table.contextId, table.resourceLinkId),
  check("lms_resources_generation_check", sql`${table.generation} > 0`),
]);
