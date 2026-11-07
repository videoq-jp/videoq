CREATE TABLE "lti_course_tag_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"course_id" bigint NOT NULL,
	"actor_key" varchar(64) NOT NULL,
	"action" text NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lti_course_tag_ops_action_check" CHECK ("lti_course_tag_operations"."action" IN ('create','update','delete','assign')),
	CONSTRAINT "lti_course_tag_ops_actor_check" CHECK ("lti_course_tag_operations"."actor_key" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "lti_course_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"course_id" bigint NOT NULL,
	"name" varchar(50) NOT NULL,
	"color" varchar(20) NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "lti_course_tags_name_key" UNIQUE("course_id","name")
);
--> statement-breakpoint
CREATE TABLE "lti_course_video_tags" (
	"tag_id" uuid NOT NULL,
	"video_id" bigint NOT NULL,
	CONSTRAINT "lti_course_video_tags_tag_id_video_id_pk" PRIMARY KEY("tag_id","video_id")
);
--> statement-breakpoint
ALTER TABLE "lti_course_tag_operations" ADD CONSTRAINT "lti_course_tag_operations_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_course_tags" ADD CONSTRAINT "lti_course_tags_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_course_video_tags" ADD CONSTRAINT "lti_course_video_tags_tag_id_lti_course_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."lti_course_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_course_video_tags" ADD CONSTRAINT "lti_course_video_tags_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lti_course_tag_ops_course_idx" ON "lti_course_tag_operations" USING btree ("course_id","created_at");--> statement-breakpoint
CREATE INDEX "lti_course_video_tags_video_idx" ON "lti_course_video_tags" USING btree ("video_id");