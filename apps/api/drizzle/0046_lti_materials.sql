CREATE TABLE "lti_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lms_courses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"context_id" text NOT NULL,
	"course_id" bigint NOT NULL,
	CONSTRAINT "lms_courses_context_key" UNIQUE("installation_id","context_id")
);
--> statement-breakpoint
CREATE TABLE "lms_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"authorization_url" text NOT NULL,
	"jwks_url" text NOT NULL,
	"sync_token_hash" text,
	"materials_service" jsonb,
	"next_materials_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"materials_cursor" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lms_installations_identity_key" UNIQUE("issuer","client_id"),
	CONSTRAINT "lms_installations_sync_token_key" UNIQUE("sync_token_hash"),
	CONSTRAINT "lms_installations_auth_mode_check" CHECK (("lms_installations"."materials_service" IS NULL AND "lms_installations"."sync_token_hash" IS NOT NULL) OR ("lms_installations"."materials_service" IS NOT NULL AND "lms_installations"."sync_token_hash" IS NULL)),
	CONSTRAINT "lms_installations_token_hash_check" CHECK ("lms_installations"."sync_token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "lms_resources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"external_id" text NOT NULL,
	"context_id" text NOT NULL,
	"resource_link_id" text NOT NULL,
	"generation" bigint NOT NULL,
	"manifest_hash" text NOT NULL,
	"enabled" boolean NOT NULL,
	"content_hash" text,
	"content_type" text,
	"file_size" bigint,
	"course_id" bigint,
	"video_id" bigint,
	"sync_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lms_resources_external_key" UNIQUE("installation_id","external_id"),
	CONSTRAINT "lms_resources_launch_key" UNIQUE("installation_id","context_id","resource_link_id"),
	CONSTRAINT "lms_resources_generation_check" CHECK ("lms_resources"."generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "lms_courses" ADD CONSTRAINT "lms_courses_installation_id_lms_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."lms_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_courses" ADD CONSTRAINT "lms_courses_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_installations" ADD CONSTRAINT "lms_installations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_resources" ADD CONSTRAINT "lms_resources_installation_id_lms_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."lms_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_resources" ADD CONSTRAINT "lms_resources_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lms_resources" ADD CONSTRAINT "lms_resources_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lti_credentials_expiry_idx" ON "lti_credentials" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "lms_installations_owner_idx" ON "lms_installations" USING btree ("owner_user_id");