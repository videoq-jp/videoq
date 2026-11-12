CREATE TABLE "lti_material_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"video_id" bigint,
	"course_id" bigint NOT NULL,
	"source_generation" bigint NOT NULL,
	"actor_key" varchar(64) NOT NULL,
	"action" text NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"before_revision" varchar(64) NOT NULL,
	"after_revision" varchar(64) NOT NULL,
	"external_task_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lti_material_ops_action_check" CHECK ("lti_material_operations"."action" IN ('update','reindex','retry')),
	CONSTRAINT "lti_material_ops_actor_check" CHECK ("lti_material_operations"."actor_key" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "lti_material_operations" ADD CONSTRAINT "lti_material_ops_resource_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."lms_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_material_operations" ADD CONSTRAINT "lti_material_ops_video_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_material_operations" ADD CONSTRAINT "lti_material_ops_course_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_material_operations" ADD CONSTRAINT "lti_material_ops_task_fk" FOREIGN KEY ("external_task_id") REFERENCES "public"."external_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lti_material_ops_resource_created_idx" ON "lti_material_operations" USING btree ("resource_id","created_at");--> statement-breakpoint
CREATE INDEX "lti_material_ops_actor_idx" ON "lti_material_operations" USING btree ("actor_key","created_at");--> statement-breakpoint
CREATE INDEX "external_tasks_video_job_idx" ON "external_tasks" USING btree (("payload"->'message'->'payload'->>'video_id'),"created_at") WHERE "external_tasks"."kind" = 'sqs_job';