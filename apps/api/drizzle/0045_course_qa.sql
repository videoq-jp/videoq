CREATE TABLE "course_question_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_question_replies_body_length" CHECK (char_length("course_question_replies"."body") BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "course_question_votes" (
	"question_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "course_question_votes_question_id_user_id_pk" PRIMARY KEY("question_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "course_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" bigint NOT NULL,
	"video_id" bigint,
	"author_id" text,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_questions_body_length" CHECK (char_length("course_questions"."body") BETWEEN 1 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "chat_log_evaluations" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "chat_logs" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "course_evaluation_snapshots" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "external_tasks" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "tags" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "video_course_members" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "video_courses" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "video_tags" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "videos" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "course_question_replies" ADD CONSTRAINT "course_question_replies_question_id_course_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."course_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_question_replies" ADD CONSTRAINT "course_question_replies_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_question_votes" ADD CONSTRAINT "course_question_votes_question_id_course_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."course_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_question_votes" ADD CONSTRAINT "course_question_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_questions" ADD CONSTRAINT "course_questions_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_questions" ADD CONSTRAINT "course_questions_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_questions" ADD CONSTRAINT "course_questions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_question_replies_question_idx" ON "course_question_replies" USING btree ("question_id","created_at");--> statement-breakpoint
CREATE INDEX "course_questions_course_created_idx" ON "course_questions" USING btree ("course_id","created_at");--> statement-breakpoint
CREATE INDEX "course_questions_video_idx" ON "course_questions" USING btree ("course_id","video_id");