CREATE TABLE "lti_report_accesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" text NOT NULL,
	"course_id" bigint NOT NULL,
	"context_id" text NOT NULL,
	"actor_key" varchar(64) NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"resource_count" integer NOT NULL,
	"scope_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lti_report_accesses_actor_check" CHECK ("lti_report_accesses"."actor_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "lti_report_accesses_scope_check" CHECK ("lti_report_accesses"."scope_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "lti_report_accesses_count_check" CHECK ("lti_report_accesses"."resource_count" BETWEEN 0 AND 1000),
	CONSTRAINT "lti_report_accesses_period_check" CHECK ("lti_report_accesses"."to_date" >= "lti_report_accesses"."from_date" AND "lti_report_accesses"."to_date" - "lti_report_accesses"."from_date" < 366)
);
--> statement-breakpoint
ALTER TABLE "lti_chat_log_subjects" ADD COLUMN "registration_id" text;--> statement-breakpoint
ALTER TABLE "lti_chat_log_subjects" ADD COLUMN "context_id" text;--> statement-breakpoint
ALTER TABLE "lti_report_accesses" ADD CONSTRAINT "lti_report_accesses_installation_id_lms_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."lms_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_report_accesses" ADD CONSTRAINT "lti_report_accesses_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lti_report_accesses_actor_idx" ON "lti_report_accesses" USING btree ("actor_key","course_id","id");--> statement-breakpoint
CREATE INDEX "lti_report_accesses_retention_idx" ON "lti_report_accesses" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "lti_chat_log_subjects_report_idx" ON "lti_chat_log_subjects" USING btree ("registration_id","context_id","chat_log_id");