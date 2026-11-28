CREATE TABLE "course_skill_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" bigint NOT NULL,
	"revision" integer NOT NULL,
	"input_key" text NOT NULL,
	"input" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"lease_token" text,
	"lease_until" bigint DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"checkpoint" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_skill_inputs" (
	"course_id" bigint PRIMARY KEY NOT NULL,
	"generation_enabled" integer DEFAULT 0 NOT NULL,
	"distribution_enabled" integer DEFAULT 0 NOT NULL,
	"policy_version" text DEFAULT '1' NOT NULL,
	"language" text DEFAULT 'ja' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"observed_input" text DEFAULT '' NOT NULL,
	"next_check_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course_skill_builds" ADD CONSTRAINT "course_skill_builds_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_skill_inputs" ADD CONSTRAINT "course_skill_inputs_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_skill_builds_input_idx" ON "course_skill_builds" USING btree ("course_id","input_key");--> statement-breakpoint
CREATE INDEX "course_skill_builds_queue_idx" ON "course_skill_builds" USING btree ("state","lease_until");--> statement-breakpoint
CREATE INDEX "course_skill_inputs_due_idx" ON "course_skill_inputs" USING btree ("generation_enabled","next_check_at");