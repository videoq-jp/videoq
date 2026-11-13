CREATE TABLE "teaching_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"installation_id" text NOT NULL,
	"context_id" text NOT NULL,
	"teacher_subject" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"course_id" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_connections_context_key" UNIQUE("provider","installation_id","context_id"),
	CONSTRAINT "teaching_connections_provider_check" CHECK ("teaching_connections"."provider" IN ('moodle','classroom'))
);
--> statement-breakpoint
ALTER TABLE "teaching_connections" ADD CONSTRAINT "teaching_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_connections" ADD CONSTRAINT "teaching_connections_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teaching_connections_owner_idx" ON "teaching_connections" USING btree ("owner_user_id");